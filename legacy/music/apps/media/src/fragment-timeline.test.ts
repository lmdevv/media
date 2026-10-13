import * as fc from "fast-check";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  type FragmentTimelineError,
  shiftTimeline,
  timelineStart,
  type TimelineState,
} from "./fragment-timeline.ts";
import { fragmentDecodeTimes } from "./testing/mp4-boxes.ts";

const box = (type: string, ...payload: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(size);

  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(new TextEncoder().encode(type), 4);
  let at = 8;

  for (const part of payload) {
    bytes.set(part, at);
    at += part.length;
  }

  return bytes;
};

const tfdt = (version: 0 | 1, time: bigint): Uint8Array => {
  const payload = new Uint8Array(version === 1 ? 12 : 8);
  const view = new DataView(payload.buffer);

  payload[0] = version;

  if (version === 1) view.setBigUint64(4, time);
  else view.setUint32(4, Number(time));

  return box("tfdt", payload);
};

/** A fragmented MP4 like ffmpeg's: `ftyp`, `moov`, then `moof` + `mdat` per fragment. */
const stream = (version: 0 | 1, times: ReadonlyArray<bigint>, mdatBytes: number): Uint8Array => {
  const parts = [
    box("ftyp", new Uint8Array(12)),
    box("moov", box("mvhd", new Uint8Array(20)), box("trak", new Uint8Array(30))),
    ...times.flatMap((time) => [
      box(
        "moof",
        box("mfhd", new Uint8Array(8)),
        box(
          "traf",
          box("tfhd", new Uint8Array(8)),
          tfdt(version, time),
          box("trun", new Uint8Array(16)),
        ),
      ),
      box("mdat", new Uint8Array(mdatBytes).fill(0x6d)),
    ]),
  ];

  return Buffer.concat(parts);
};

/** Feeds `bytes` through the shift in pieces cut at `cuts`. */
const shiftInPieces = (
  bytes: Uint8Array,
  cuts: ReadonlyArray<number>,
  target: bigint,
): Result.Result<Uint8Array, FragmentTimelineError> => {
  const edges = [
    0,
    ...cuts.filter((cut) => cut > 0 && cut < bytes.length).toSorted((a, b) => a - b),
    bytes.length,
  ];

  const out: Array<Uint8Array> = [];
  let state: TimelineState = timelineStart;

  for (let index = 1; index < edges.length; index += 1) {
    const step = shiftTimeline(target)(state, bytes.slice(edges[index - 1], edges[index]));

    if (Result.isFailure(step)) return Result.fail(step.failure);
    [state] = step.success;
    out.push(...step.success[1]);
  }

  expect(state.pending).toHaveLength(0);

  return Result.succeed(Buffer.concat(out));
};

describe("shiftTimeline", () => {
  it("moves every fragment so the first starts at the target, however the bytes arrive", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<0 | 1>(0, 1),
        fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 2n ** 31n }),
        fc.integer({ min: 0, max: 300 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        (version, steps, target, mdatBytes, cuts) => {
          let elapsed = 0n;

          const times = steps.map((step) => (elapsed += BigInt(step)));

          const input = stream(version, times, mdatBytes);

          const shifted = Result.getOrThrow(
            shiftInPieces(
              input,
              cuts.map((cut) => cut % (input.length + 1)),
              target,
            ),
          );

          const first = times[0] ?? 0n;

          // Only the decode times change.
          expect(shifted).toEqual(
            stream(
              version,
              times.map((time) => time - first + target),
              mdatBytes,
            ),
          );
          expect(fragmentDecodeTimes(shifted)[0]).toBe(target);
        },
      ),
    );
  });

  it("rejects malformed boxes and times that do not fit", () => {
    const tooSmall = new Uint8Array([0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x66]);

    expect(Result.isFailure(shiftInPieces(tooSmall, [], 0n))).toBe(true);

    const overflowing = shiftInPieces(stream(0, [0n], 4), [], 2n ** 32n);

    expect(Result.isFailure(overflowing) && overflowing.failure.reason).toBe("overflow");
  });
});
