/**
 * Reads the header of the media service's fragmented MP4 streams: everything before the first
 * `moof`, which is `ftyp`, `moov` (the initialization segment), and a global `sidx` that indexes
 * every fragment. Pure; the MSE engine feeds it the first bytes of a response.
 */
import { Data } from "effect";

/** The audio codecs the gapless profiles carry. */
export type AudioCodec = "flac" | "aac";

/** One fragment (`moof` + `mdat`) of a stream, as the `sidx` describes it. */
export interface Fragment {
  /** Byte offset of the fragment's `moof` from the start of the file. */
  readonly offset: number;
  readonly size: number;
  /** Media time of the fragment's first sample, in `timescale` units. */
  readonly time: number;
  readonly duration: number;
}

/** Where each fragment starts, in bytes and in media time. */
export interface SegmentIndex {
  /** Media time units per second (the sample rate for the media service's streams). */
  readonly timescale: number;
  readonly fragments: ReadonlyArray<Fragment>;
}

/** What the engine needs from a stream's header. */
export interface StreamHeader {
  readonly codec: AudioCodec;
  /** `ftyp` + `moov`: the initialization segment to append before any fragment. */
  readonly init: Uint8Array<ArrayBuffer>;
  /** Bytes before the first `moof`. */
  readonly length: number;
  /** The fragment index, or null when the stream has no `sidx`. */
  readonly index: SegmentIndex | null;
}

/** The outcome of reading a header from the first bytes of a stream. */
export type HeaderRead = Data.TaggedEnum<{
  /** The header continues past the bytes so far. */
  Incomplete: {};
  /** The bytes are not a fragmented MP4 stream the engine can play. */
  Invalid: { readonly reason: string };
  Complete: { readonly header: StreamHeader };
}>;

/** Constructors and matchers for `HeaderRead`. */
export const HeaderRead = Data.taggedEnum<HeaderRead>();

/** Sample entry types (in `stsd`) of the codecs the engine plays. */
const SAMPLE_ENTRIES: ReadonlyMap<string, AudioCodec> = new Map([
  ["fLaC", "flac"],
  ["mp4a", "aac"],
]);

/** MIME type with codecs for `MediaSource.isTypeSupported`, `addSourceBuffer`, and `changeType`. */
export const codecMimeType = (codec: AudioCodec): string =>
  codec === "flac" ? 'audio/mp4; codecs="flac"' : 'audio/mp4; codecs="mp4a.40.2"';

interface Box {
  readonly type: string;
  /** Offset of the box header within the scanned bytes. */
  readonly start: number;
  /** Offset of the payload (after the header). */
  readonly body: number;
  /** Offset just past the box. */
  readonly end: number;
}

/** The bytes of `head` followed by those of `tail`, in a new buffer. */
export const concatBytes = (head: Uint8Array, tail: Uint8Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(head.length + tail.length);
  bytes.set(head);
  bytes.set(tail, head.length);

  return bytes;
};

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const fourCC = (bytes: Uint8Array, at: number): string =>
  String.fromCodePoint(...bytes.subarray(at, at + 4));

/**
 * The box starting at `at` within `[at, limit)`, or null when its header or body runs past
 * `limit`. Sizes 0 ("to the end") are only valid for the last box and are reported as invalid
 * here, because the header boxes the engine reads always have explicit sizes.
 */
const boxAt = (bytes: Uint8Array, at: number, limit: number): Box | null | "invalid" => {
  if (at + 8 > limit) return null;
  const data = view(bytes);
  const size32 = data.getUint32(at);
  const type = fourCC(bytes, at + 4);

  if (size32 === 1) {
    if (at + 16 > limit) return null;
    const size = Number(data.getBigUint64(at + 8));

    if (size < 16) return "invalid";

    return at + size > limit ? null : { type, start: at, body: at + 16, end: at + size };
  }

  if (size32 < 8) return "invalid";

  return at + size32 > limit ? null : { type, start: at, body: at + 8, end: at + size32 };
};

/** The children of a container box, all of which must lie inside it. */
const childrenOf = (bytes: Uint8Array, parent: Box): ReadonlyArray<Box> | null => {
  const children: Array<Box> = [];

  for (let at = parent.body; at < parent.end;) {
    const child = boxAt(bytes, at, parent.end);

    if (child === null || child === "invalid") return null;
    children.push(child);
    at = child.end;
  }

  return children;
};

/** The first sample entry type in `moov/trak/mdia/minf/stbl/stsd`, or null. */
const sampleEntryType = (bytes: Uint8Array, moov: Box): string | null => {
  const path = ["trak", "mdia", "minf", "stbl", "stsd"];
  let current: Box = moov;

  for (const name of path) {
    const next = childrenOf(bytes, current)?.find((child) => child.type === name);

    if (next === undefined) return null;
    current = next;
  }

  // stsd: version and flags (4), entry count (4), then sample entries (size, type, ...).
  const entry = current.body + 8;

  return entry + 8 <= current.end ? fourCC(bytes, entry + 4) : null;
};

/** Parses a `sidx` box into absolute fragment offsets and media times. */
const parseSidx = (bytes: Uint8Array, sidx: Box): SegmentIndex | null => {
  const data = view(bytes);
  const version = data.getUint8(sidx.body);
  let at = sidx.body + 8;

  if (at + 4 > sidx.end) return null;
  const timescale = data.getUint32(at);
  at += 4;
  const wide = version !== 0;

  if (at + (wide ? 16 : 8) + 4 > sidx.end) return null;
  const earliest = wide ? Number(data.getBigUint64(at)) : data.getUint32(at);
  const firstOffset = wide ? Number(data.getBigUint64(at + 8)) : data.getUint32(at + 4);
  at += wide ? 16 : 8;
  const count = data.getUint16(at + 2);
  at += 4;

  if (timescale === 0 || at + count * 12 > sidx.end) return null;
  const fragments: Array<Fragment> = [];
  let offset = sidx.end + firstOffset;
  let time = earliest;

  for (let index = 0; index < count; index += 1) {
    const reference = data.getUint32(at + index * 12);

    // A set top bit points at another sidx; the media service never nests them.
    if (reference >>> 31 !== 0) return null;
    const size = reference & 0x7f_ff_ff_ff;
    const duration = data.getUint32(at + index * 12 + 4);
    fragments.push({ offset, size, time, duration });
    offset += size;
    time += duration;
  }

  return { timescale, fragments };
};

/**
 * Reads the stream header from the first `bytes` of a stream. Returns `Incomplete` until the
 * first `moof` header is in view, then `Complete` (or `Invalid` when the stream is not a
 * fragmented MP4 with a FLAC or AAC track).
 */
export const readHeader = (bytes: Uint8Array): HeaderRead => {
  let moov: Box | null = null;
  let sidx: Box | null = null;

  for (let at = 0; ;) {
    if (at + 8 > bytes.length) return HeaderRead.Incomplete();
    const type = fourCC(bytes, at + 4);

    if (type === "moof") {
      if (moov === null) return HeaderRead.Invalid({ reason: "The stream has no moov box" });
      const entry = sampleEntryType(bytes, moov);

      const codec = entry === null ? undefined : SAMPLE_ENTRIES.get(entry);

      if (codec === undefined) {
        return HeaderRead.Invalid({ reason: `Unsupported sample entry ${entry ?? "(none)"}` });
      }

      return HeaderRead.Complete({
        header: {
          codec,
          init: bytes.slice(0, moov.end),
          length: at,
          index: sidx === null ? null : parseSidx(bytes, sidx),
        },
      });
    }

    const box = boxAt(bytes, at, bytes.length);

    if (box === "invalid") return HeaderRead.Invalid({ reason: `Malformed ${type} box` });

    if (box === null) return HeaderRead.Incomplete();

    if (box.type === "moov") moov = box;

    if (box.type === "sidx") sidx = box;
    at = box.end;
  }
};
