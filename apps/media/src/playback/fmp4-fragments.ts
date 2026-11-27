/**
 * Reads where an fMP4 fragment file starts and ends, and drops what an init segment must not
 * carry. ffmpeg's HLS muxer writes one file per keyframe interval here: `styp`, a `sidx` per track
 * unless the run skips them, then a `moof` with one `traf` per track.
 *
 * The times come from the video `traf` (its `tfdt` and `trun`) and the init segment's edit list,
 * never from a `sidx`: ffmpeg 8.0 writes a `sidx` earliest presentation time one frame late for
 * runs that start at the beginning of the file, while the `moof` it writes is the same as other
 * versions'.
 */

/**
 * Bytes worth reading from the head of a fragment: enough for the `moof` of a fragment of a few
 * hundred samples, and always enough to find where a longer one ends.
 */
export const FRAGMENT_HEAD_BYTES = 16 * 1024;

/** How the init segment times the video track's samples. */
export interface VideoTiming {
  readonly trackId: number;
  /** Media timescale of the track, in units per second. */
  readonly timescale: number;
  /** Media time, in track units, presented at time 0 (the edit list's shift). */
  readonly presentationOffset: number;
  /** The `trex` sample duration, for fragments that name none. */
  readonly defaultSampleDuration: number | undefined;
}

/**
 * Where a fragment's video starts and ends, in seconds on the source timeline.
 *
 * With open-GOP video, leading pictures follow a keyframe in decode order but are presented
 * before it, so a fragment's `start` is later than its earliest picture, and the fragment before
 * it ends short of that `start` by the leading pictures' span.
 */
export interface FragmentSpan {
  /** Presentation time of the first sample in decode order: the fragment's keyframe. */
  readonly start: number;
  /**
   * The latest presentation end among the samples (presentation time plus duration);
   * `undefined` when the fragment gives no sample durations.
   */
  readonly end: number | undefined;
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

interface Box {
  readonly type: string;
  /** Offset of the box's payload, after its header. */
  readonly body: number;
  /** Offset just past the box. */
  readonly end: number;
}

/**
 * The box whose header starts at `offset`, which may run past `limit`; `undefined` when the
 * header does not fit before `limit` or names an impossible size. Size 0 runs to `limit`.
 */
const headerAt = (bytes: Uint8Array, offset: number, limit: number): Box | undefined => {
  if (offset + 8 > limit) return undefined;

  const view = viewOf(bytes);
  const size32 = view.getUint32(offset);
  const type = String.fromCodePoint(...bytes.subarray(offset + 4, offset + 8));

  if (size32 === 1) {
    if (offset + 16 > limit) return undefined;

    const size = Number(view.getBigUint64(offset + 8));

    return size < 16 ? undefined : { type, body: offset + 16, end: offset + size };
  }

  if (size32 === 0) return { type, body: offset + 8, end: limit };

  return size32 < 8 ? undefined : { type, body: offset + 8, end: offset + size32 };
};

const boxesIn = (bytes: Uint8Array, start: number, end: number): ReadonlyArray<Box> => {
  const boxes: Array<Box> = [];

  for (let box = headerAt(bytes, start, end); box !== undefined && box.end <= end;) {
    boxes.push(box);
    box = headerAt(bytes, box.end, end);
  }

  return boxes;
};

const childOf = (bytes: Uint8Array, parent: Box, type: string): Box | undefined =>
  boxesIn(bytes, parent.body, parent.end).find((box) => box.type === type);

const childrenOf = (bytes: Uint8Array, parent: Box, type: string): ReadonlyArray<Box> =>
  boxesIn(bytes, parent.body, parent.end).filter((box) => box.type === type);

/**
 * A full box's version and flags, and whether `length` payload bytes after them are present; a
 * box too short for its version and flags reads as version 0, flags 0, and never fits.
 */
const fullBox = (bytes: Uint8Array, box: Box, length: number) => {
  const whole = box.body + 4 <= box.end;

  return {
    version: whole ? (bytes[box.body] ?? 0) : 0,
    flags: whole ? viewOf(bytes).getUint32(box.body) & 0xff_ff_ff : 0,
    fits: box.body + 4 + length <= box.end,
  };
};

const uint64 = (view: DataView, offset: number): number => Number(view.getBigUint64(offset));

const int64 = (view: DataView, offset: number): number => Number(view.getBigInt64(offset));

/**
 * The field after a `mvhd`, `tkhd`, or `mdhd` box's creation and modification times: the movie
 * timescale, track id, or media timescale. `undefined` when the box is too short to hold it.
 */
const afterTimes = (bytes: Uint8Array, box: Box | undefined): number | undefined => {
  if (box === undefined) return undefined;
  const offset = box.body + (bytes[box.body] === 1 ? 20 : 12);

  return offset + 4 <= box.end ? viewOf(bytes).getUint32(offset) : undefined;
};

/** The `trex` default sample duration for `trackId`, from `moov.mvex`. */
const trexDuration = (bytes: Uint8Array, moov: Box, trackId: number): number | undefined => {
  const mvex = childOf(bytes, moov, "mvex");
  const view = viewOf(bytes);

  const trex = (mvex === undefined ? [] : childrenOf(bytes, mvex, "trex")).find(
    (box) => fullBox(bytes, box, 16).fits && view.getUint32(box.body + 4) === trackId,
  );

  return trex === undefined ? undefined : view.getUint32(trex.body + 12);
};

/**
 * The media time presented at 0: the first media edit's start, less any empty edits before it.
 * `undefined` when the edit list is cut off.
 */
const editOffset = (
  bytes: Uint8Array,
  elst: Box | undefined,
  timescale: number,
  movieTimescale: number,
): number | undefined => {
  if (elst === undefined) return 0;

  const view = viewOf(bytes);
  const { version, fits } = fullBox(bytes, elst, 4);

  if (!fits) return undefined;
  const count = view.getUint32(elst.body + 4);
  const entryBytes = version === 1 ? 20 : 12;

  if (elst.body + 8 + count * entryBytes > elst.end) return undefined;
  let empty = 0;

  for (let index = 0; index < count; index += 1) {
    const entry = elst.body + 8 + index * entryBytes;
    const duration = version === 1 ? uint64(view, entry) : view.getUint32(entry);
    const mediaTime = version === 1 ? int64(view, entry + 8) : view.getInt32(entry + 4);

    if (mediaTime !== -1) return mediaTime - (empty * timescale) / movieTimescale;
    empty += duration;
  }

  return 0;
};

/**
 * The video track's timing from an init segment. `undefined` when `init` has no whole `moov`
 * with a video track.
 */
export const videoTiming = (init: Uint8Array): VideoTiming | undefined => {
  const moov = boxesIn(init, 0, init.byteLength).find((box) => box.type === "moov");

  if (moov === undefined) return undefined;
  const movieTimescale = afterTimes(init, childOf(init, moov, "mvhd"));

  if (movieTimescale === undefined) return undefined;

  for (const trak of childrenOf(init, moov, "trak")) {
    const mdia = childOf(init, trak, "mdia");
    const hdlr = mdia === undefined ? undefined : childOf(init, mdia, "hdlr");

    if (hdlr === undefined || !fullBox(init, hdlr, 8).fits) continue;

    const handler = String.fromCodePoint(...init.subarray(hdlr.body + 8, hdlr.body + 12));

    if (handler !== "vide") continue;

    const trackId = afterTimes(init, childOf(init, trak, "tkhd"));
    const mdhd = mdia === undefined ? undefined : childOf(init, mdia, "mdhd");
    const timescale = afterTimes(init, mdhd);

    if (trackId === undefined || timescale === undefined) return undefined;
    const edts = childOf(init, trak, "edts");
    const elst = edts === undefined ? undefined : childOf(init, edts, "elst");
    const presentationOffset = editOffset(init, elst, timescale, movieTimescale);

    if (timescale === 0 || movieTimescale === 0 || presentationOffset === undefined) {
      return undefined;
    }

    return {
      trackId,
      timescale,
      presentationOffset,
      defaultSampleDuration: trexDuration(init, moov, trackId),
    };
  }

  return undefined;
};

/** The boxes from an init segment's top level down to a track's sample table. */
const SAMPLE_TABLE_PATH = ["moov", "trak", "mdia", "minf", "stbl"] as const;

/**
 * `init` without the sample dependency boxes (`sdtp`) that list no sample, or `init` itself when it
 * has none. ffmpeg 7.1's MP4 muxer writes one into a fragmented stream's init segment, whose
 * sample tables are empty, for each track whose encoder marked a picture disposable, as libx265 and
 * libsvtav1 mark their non-reference pictures; AVFoundation then exposes no video track, and
 * Apple's players say "Cannot Open". ffmpeg 8 writes none for an empty sample table. Boxes with a
 * 64-bit size are left as they are.
 */
export const withoutEmptySampleDependencies = (init: Uint8Array): Uint8Array => {
  const view = viewOf(init);
  // A box whose 32-bit size field, just before its type, spans it.
  const plain = (box: Box): boolean => view.getUint32(box.body - 8) === box.end - box.body + 8;
  const dropped: Array<Box> = [];
  const shrunk = new Map<number, number>();

  const visit = (start: number, end: number, ancestors: ReadonlyArray<Box>): void => {
    for (const box of boxesIn(init, start, end)) {
      if (ancestors.length < SAMPLE_TABLE_PATH.length) {
        if (box.type === SAMPLE_TABLE_PATH[ancestors.length]) {
          visit(box.body, box.end, [...ancestors, box]);
        }
      } else if (box.type === "sdtp" && box.end - box.body === 4 && plain(box)) {
        if (!ancestors.every(plain)) continue;
        dropped.push(box);

        for (const ancestor of ancestors) {
          shrunk.set(
            ancestor.body - 8,
            (shrunk.get(ancestor.body - 8) ?? 0) + box.end - box.body + 8,
          );
        }
      }
    }
  };

  visit(0, init.byteLength, []);

  if (dropped.length === 0) return init;

  // A copy: `slice` of a Node Buffer, as files read back, would share the caller's bytes.
  const resized = new Uint8Array(init);
  const resizedView = viewOf(resized);

  for (const [header, bytes] of shrunk) {
    resizedView.setUint32(header, resizedView.getUint32(header) - bytes);
  }

  const kept: Array<Uint8Array> = [];
  let from = 0;

  for (const box of dropped) {
    kept.push(resized.subarray(from, box.body - 8));
    from = box.end;
  }

  kept.push(resized.subarray(from));

  const out = new Uint8Array(kept.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;

  for (const part of kept) {
    out.set(part, at);
    at += part.byteLength;
  }

  return out;
};

/**
 * How many bytes from the start of a fragment hold everything up to the end of its `moof`, read
 * from the box headers in `head`. `undefined` when `head` does not reach the `moof`'s header.
 */
export const fragmentHeadLength = (head: Uint8Array): number | undefined => {
  for (let box = headerAt(head, 0, head.byteLength); box !== undefined;) {
    if (box.type === "moof") return box.end;

    if (box.type === "mdat") return undefined;
    box = headerAt(head, box.end, head.byteLength);
  }

  return undefined;
};

const TFHD = { baseDataOffset: 0x01, sampleDescription: 0x02, defaultDuration: 0x08 } as const;

/** `trun` flags; the last four are per-sample fields, written in this order. */
const TRUN = {
  dataOffset: 0x01,
  firstSampleFlags: 0x04,
  duration: 0x1_00,
  size: 0x2_00,
  flags: 0x4_00,
  compositionOffset: 0x8_00,
} as const;

/** The `tfhd` default sample duration, when it sets one. */
const tfhdDuration = (bytes: Uint8Array, tfhd: Box): number | undefined => {
  const { flags } = fullBox(bytes, tfhd, 4);

  if ((flags & TFHD.defaultDuration) === 0) return undefined;

  const offset =
    tfhd.body +
    8 +
    ((flags & TFHD.baseDataOffset) === 0 ? 0 : 8) +
    ((flags & TFHD.sampleDescription) === 0 ? 0 : 4);

  return offset + 4 <= tfhd.end ? viewOf(bytes).getUint32(offset) : undefined;
};

/**
 * The span of the video track's samples in `fragment`, which must hold the fragment's bytes from
 * its start through its `moof` (see {@link fragmentHeadLength}). `undefined` when it holds no
 * `moof` with the track's decode time and samples.
 */
export const fragmentSpan = (
  timing: VideoTiming,
  fragment: Uint8Array,
): FragmentSpan | undefined => {
  const view = viewOf(fragment);
  const top = boxesIn(fragment, 0, fragment.byteLength);
  const moofAt = top.findIndex((box) => box.type === "moof");

  if (moofAt === -1 || top.slice(0, moofAt).some((box) => box.type === "mdat")) return undefined;
  const moof = top[moofAt];

  const traf = (moof === undefined ? [] : childrenOf(fragment, moof, "traf")).find((box) => {
    const tfhd = childOf(fragment, box, "tfhd");

    return (
      tfhd !== undefined &&
      fullBox(fragment, tfhd, 4).fits &&
      view.getUint32(tfhd.body + 4) === timing.trackId
    );
  });

  const tfhd = traf === undefined ? undefined : childOf(fragment, traf, "tfhd");
  const tfdt = traf === undefined ? undefined : childOf(fragment, traf, "tfdt");

  if (traf === undefined || tfhd === undefined || tfdt === undefined) return undefined;
  const tfdtVersion = fullBox(fragment, tfdt, 0).version;

  if (!fullBox(fragment, tfdt, tfdtVersion === 1 ? 8 : 4).fits) return undefined;

  const defaultDuration = tfhdDuration(fragment, tfhd) ?? timing.defaultSampleDuration;
  let decode = tfdtVersion === 1 ? uint64(view, tfdt.body + 4) : view.getUint32(tfdt.body + 4);
  let first: number | undefined;
  let latestEnd = Number.NEGATIVE_INFINITY;
  let durationsKnown = true;

  for (const trun of childrenOf(fragment, traf, "trun")) {
    const { flags, fits } = fullBox(fragment, trun, 4);

    if (!fits) return undefined;
    const count = view.getUint32(trun.body + 4);

    const fields = [TRUN.duration, TRUN.size, TRUN.flags, TRUN.compositionOffset].filter(
      (field) => (flags & field) !== 0,
    );

    const durationAt = fields.indexOf(TRUN.duration);
    const compositionAt = fields.indexOf(TRUN.compositionOffset);

    let offset =
      trun.body +
      8 +
      ((flags & TRUN.dataOffset) === 0 ? 0 : 4) +
      ((flags & TRUN.firstSampleFlags) === 0 ? 0 : 4);

    if (offset + count * fields.length * 4 > trun.end) return undefined;

    const read = fields.length === 0 ? Math.min(count, 1) : count;
    const repeats = fields.length === 0 ? count : 1;

    for (let index = 0; index < read; index += 1) {
      const duration =
        durationAt === -1 ? defaultDuration : view.getUint32(offset + durationAt * 4);

      // Signed in either trun version: ffmpeg writes negative offsets into version 0 too, and
      // reads them back as signed.
      const composition = compositionAt === -1 ? 0 : view.getInt32(offset + compositionAt * 4);
      const presented = decode + composition - timing.presentationOffset;

      first ??= presented;

      if (duration === undefined) durationsKnown = false;
      latestEnd = Math.max(latestEnd, presented + (duration ?? 0) * repeats);
      decode += (duration ?? 0) * repeats;
      offset += fields.length * 4;
    }
  }

  if (first === undefined) return undefined;

  return {
    start: first / timing.timescale,
    end: durationsKnown ? latestEnd / timing.timescale : undefined,
  };
};
