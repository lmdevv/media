/**
 * Moves a fragmented MP4 byte stream onto another timeline as it passes through: every fragment's
 * decode time (`moof/traf/tfdt`) shifts so the first one lands on a chosen value. ffmpeg starts
 * the decode times of a stream encoded from an offset at zero, whatever `-output_ts_offset` says,
 * so the transcoder sets them itself. Pure: the caller threads the state through the chunks.
 */
import { Data, Option, Result } from "effect";

const HEADER = 8;

/** Boxes on the way from `moof` down to `tfdt`. */
const CONTAINERS: ReadonlySet<string> = new Set(["moof", "traf"]);

/** The stream is not the fragmented MP4 it should be, or its times do not fit the shift. */
export class FragmentTimelineError extends Data.TaggedError("FragmentTimelineError")<{
  readonly reason: "malformed" | "overflow";
}> {
  override get message(): string {
    return `Fragment timeline shift failed: ${this.reason}`;
  }
}

/** Where a shift is between two chunks. */
export interface TimelineState {
  /** Bytes of a box header or of a `moof` that are not complete yet. */
  readonly pending: Uint8Array;
  /** Bytes of the current non-`moof` box still to pass through untouched. */
  readonly passthrough: number;
  /** What to add to every decode time, once the first fragment set it. */
  readonly shift: Option.Option<bigint>;
}

/** The state before the first byte. */
export const timelineStart: TimelineState = {
  pending: new Uint8Array(),
  passthrough: 0,
  shift: Option.none(),
};

const typeAt = (bytes: Uint8Array, at: number): string =>
  String.fromCodePoint(...bytes.subarray(at + 4, at + HEADER));

/** The box size at `at`, or none when the header is not all there yet; 0 means "to the end". */
const sizeAt = (bytes: Uint8Array, at: number): Option.Option<number> => {
  if (bytes.length - at < HEADER) return Option.none();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(at);

  if (size !== 1) return Option.some(size);

  if (bytes.length - at < HEADER + 8) return Option.none();

  return Option.some(Number(view.getBigUint64(at + HEADER)));
};

/**
 * Rewrites the `tfdt` boxes inside one complete `moof` in place, setting the shift from the
 * first one when it is still unknown. Returns the shift used.
 */
const shiftMoof = (
  moof: Uint8Array,
  target: bigint,
  known: Option.Option<bigint>,
): Result.Result<Option.Option<bigint>, FragmentTimelineError> => {
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  let shift = Option.getOrNull(known);

  const walk = (start: number, end: number): Result.Result<void, FragmentTimelineError> => {
    for (let at = start; at < end;) {
      const size = end - at >= HEADER ? view.getUint32(at) : 0;

      if (size < HEADER || at + size > end) {
        return Result.fail(new FragmentTimelineError({ reason: "malformed" }));
      }

      const type = typeAt(moof, at);

      if (CONTAINERS.has(type)) {
        const inner = walk(at + HEADER, at + size);

        if (Result.isFailure(inner)) return inner;
      } else if (type === "tfdt") {
        const version = moof[at + HEADER] ?? 0;
        const field = at + HEADER + 4;

        if (field + (version === 1 ? 8 : 4) > at + size) {
          return Result.fail(new FragmentTimelineError({ reason: "malformed" }));
        }

        const current = version === 1 ? view.getBigUint64(field) : BigInt(view.getUint32(field));

        shift ??= target - current;
        const shifted = current + shift;

        if (shifted < 0n || shifted >= (version === 1 ? 2n ** 64n : 2n ** 32n)) {
          return Result.fail(new FragmentTimelineError({ reason: "overflow" }));
        }

        if (version === 1) view.setBigUint64(field, shifted);
        else view.setUint32(field, Number(shifted));
      }

      at += size;
    }

    return Result.succeed(undefined);
  };

  return Result.map(walk(HEADER, moof.length), () => Option.fromNullishOr(shift));
};

/**
 * Passes `chunk` on with every fragment's decode time shifted so the stream's first fragment
 * starts at `target` (in the track's timescale, the sample rate for audio) and later fragments
 * keep their distance from it. Bytes outside `moof` boxes pass through as they come; a `moof`
 * is held back until it is complete.
 *
 * @returns The next state and the bytes to send, or `FragmentTimelineError` when a box is
 *   malformed or a shifted time does not fit its field.
 */
export const shiftTimeline =
  (target: bigint) =>
  (
    state: TimelineState,
    chunk: Uint8Array,
  ): Result.Result<readonly [TimelineState, ReadonlyArray<Uint8Array>], FragmentTimelineError> => {
    const out: Array<Uint8Array> = [];
    let bytes = chunk;
    let { passthrough, shift } = state;

    if (state.pending.length > 0) {
      bytes = new Uint8Array(state.pending.length + chunk.length);
      bytes.set(state.pending);
      bytes.set(chunk, state.pending.length);
    }

    let at = 0;

    while (at < bytes.length) {
      if (passthrough > 0) {
        const take = Math.min(passthrough, bytes.length - at);
        out.push(bytes.subarray(at, at + take));
        passthrough -= take;
        at += take;
        continue;
      }

      const size = sizeAt(bytes, at);

      if (Option.isNone(size)) break;

      // A box that runs to the end of the stream is never a `moof`.
      if (size.value === 0) {
        passthrough = Number.POSITIVE_INFINITY;
        continue;
      }

      if (size.value < HEADER) {
        return Result.fail(new FragmentTimelineError({ reason: "malformed" }));
      }

      if (typeAt(bytes, at) !== "moof") {
        passthrough = size.value;
        continue;
      }

      if (bytes.length - at < size.value) break;
      // A copy: the chunk may be a view the caller still holds.
      const moof = bytes.slice(at, at + size.value);
      const shifted = shiftMoof(moof, target, shift);

      if (Result.isFailure(shifted)) return Result.fail(shifted.failure);
      shift = shifted.success;
      out.push(moof);
      at += size.value;
    }

    return Result.succeed([{ pending: bytes.slice(at), passthrough, shift }, out] as const);
  };
