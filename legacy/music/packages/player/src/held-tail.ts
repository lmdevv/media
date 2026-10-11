/**
 * Holds back the end of a fragmented stream that is still being transcoded. Its exact length is
 * only known once the transcode finishes, and the engine must not append the samples around the
 * end before it can cut them exactly with the append window. The last real sample always lies in
 * the last two fragments: every fragment but the last spans at least a second, and the encoder
 * pads the end by a few thousand samples at most. So the engine appends everything before the
 * second-to-last fragment as it arrives and keeps the rest until the stream ends. Pure.
 */
import { Data } from "effect";

import { concatBytes } from "./fmp4";

/** Bytes of a stream and the file offset of their first byte. */
export interface Piece {
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** The held end of a stream: bytes read but not appended, and how far its boxes are known. */
export interface HeldTail {
  /** File offset of the first held byte. */
  readonly offset: number;
  /** The held bytes, in file order. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** File offset of the next top-level box whose header has not been read yet. */
  readonly nextBox: number;
  /** File offsets of the last two `moof` boxes seen, oldest first. */
  readonly fragments: ReadonlyArray<number>;
}

/** The outcome of adding bytes to a held tail. */
export type TailStep = Data.TaggedEnum<{
  /** The new tail, and the bytes before it that can be appended now (null when none). */
  Held: { readonly tail: HeldTail; readonly release: Piece | null };
  /** The bytes are not a sequence of MP4 boxes. */
  Invalid: { readonly reason: string };
}>;

/** Constructors and matchers for `TailStep`. */
export const TailStep = Data.taggedEnum<TailStep>();

/** An empty tail for a stream whose fragments start at file offset `offset`. */
export const holdTail = (offset: number): HeldTail => ({
  offset,
  bytes: new Uint8Array(0),
  nextBox: offset,
  fragments: [],
});

/**
 * Adds the next bytes of the stream, which continue right after the held ones, and releases
 * everything before the second-to-last fragment seen so far.
 */
export const addToTail = (tail: HeldTail, next: Uint8Array): TailStep => {
  const bytes = concatBytes(tail.bytes, next);
  const view = new DataView(bytes.buffer);
  const end = tail.offset + bytes.length;
  let nextBox = tail.nextBox;
  let fragments = tail.fragments;

  while (nextBox + 8 <= end) {
    const at = nextBox - tail.offset;
    const size32 = view.getUint32(at);
    const type = String.fromCodePoint(...bytes.subarray(at + 4, at + 8));

    if (size32 === 1 && nextBox + 16 > end) break;
    const size = size32 === 1 ? Number(view.getBigUint64(at + 8)) : size32;

    // Size 0 ("to the end of the file") never occurs in a stream that is still being written.
    if (size < 8) return TailStep.Invalid({ reason: `Malformed ${type} box in the stream` });

    if (type === "moof") fragments = [...fragments, nextBox].slice(-2);
    nextBox += size;
  }

  const limit = fragments.length === 2 ? (fragments[0] ?? tail.offset) : tail.offset;
  const cut = limit - tail.offset;

  return TailStep.Held({
    tail: { offset: limit, bytes: bytes.slice(cut), nextBox, fragments },
    release: cut > 0 ? { offset: tail.offset, bytes: bytes.slice(0, cut) } : null,
  });
};

/** Everything still held, once the stream has ended; null when nothing is. */
export const releaseAll = (tail: HeldTail): Piece | null =>
  tail.bytes.length > 0 ? { offset: tail.offset, bytes: tail.bytes } : null;
