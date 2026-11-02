/**
 * Reads where an fMP4 fragment file starts and ends. ffmpeg's HLS muxer writes one file per
 * keyframe interval here: `styp`, one `sidx` per track, then a `moof` with one `traf` per track.
 *
 * The times come from the video `traf` (its `tfdt` and `trun`) and the init segment's edit list,
 * not from the `sidx`: ffmpeg 8.0 writes a `sidx` earliest presentation time one frame late for
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
 * Where a fragment's video starts and ends, in seconds on the source timeline: from its first
 * sample's presentation time, for the sum of its sample durations, so `end` is the next
 * fragment's `start` to within a tick of the track's timescale (a next fragment whose first
 * frame is presented before it is decoded starts that much early). `end` is `undefined` when the
 * fragment gives no sample durations.
 */
export interface FragmentSpan {
  readonly start: number;
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
  let total = 0;
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
      total += (duration ?? 0) * repeats;
      decode += (duration ?? 0) * repeats;
      offset += fields.length * 4;
    }
  }

  if (first === undefined) return undefined;

  return {
    start: first / timing.timescale,
    end: durationsKnown ? (first + total) / timing.timescale : undefined,
  };
};
