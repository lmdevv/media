import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { concatBytes } from "./fmp4";
import { addToTail, holdTail, releaseAll, TailStep } from "./held-tail";
import type { HeldTail, Piece } from "./held-tail";

/** A top-level box with a 32-bit size, or a 64-bit one (`size` field 1) when `wide`. */
const box = (type: string, payload: number, wide: boolean): Uint8Array<ArrayBuffer> => {
  const header = wide ? 16 : 8;
  const bytes = new Uint8Array(header + payload).fill(0xab, header);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, wide ? 1 : header + payload);
  bytes.set(new TextEncoder().encode(type), 4);

  if (wide) view.setBigUint64(8, BigInt(header + payload));

  return bytes;
};

/** The media part of a live stream: fragments of `moof` then `mdat`, and where each starts. */
const streamArbitrary = fc
  .array(
    fc.record({
      moof: fc.integer({ min: 0, max: 40 }),
      mdat: fc.integer({ min: 0, max: 300 }),
      wide: fc.boolean(),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((fragments) => {
    const boxes = fragments.flatMap(({ moof, mdat, wide }) => [
      box("moof", moof, false),
      box("mdat", mdat, wide),
    ]);

    const starts = boxes.reduce<ReadonlyArray<number>>(
      (offsets, current, index) =>
        index === 0 ? [0] : [...offsets, (offsets.at(-1) ?? 0) + (boxes[index - 1]?.length ?? 0)],
      [],
    );

    return {
      bytes: boxes.reduce<Uint8Array<ArrayBuffer>>(
        (all, current) => concatBytes(all, current),
        new Uint8Array(0),
      ),
      moofs: starts.filter((_, index) => index % 2 === 0),
    };
  });

/** Cut points that split `length` bytes into consecutive chunks. */
const chunksOf = (bytes: Uint8Array, cuts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
  const points = [
    ...new Set([0, ...cuts.map((cut) => cut % (bytes.length + 1)), bytes.length]),
  ].toSorted((left, right) => left - right);

  return points.slice(1).map((end, index) => bytes.subarray(points[index] ?? 0, end));
};

/** Feeds chunks in order; returns every release and the final tail. */
const feed = (
  offset: number,
  chunks: ReadonlyArray<Uint8Array>,
): { readonly releases: ReadonlyArray<Piece>; readonly tail: HeldTail } =>
  chunks.reduce<{ readonly releases: ReadonlyArray<Piece>; readonly tail: HeldTail }>(
    (state, chunk) => {
      const step = addToTail(state.tail, chunk);

      if (TailStep.$is("Invalid")(step)) throw new Error(step.reason);

      return {
        releases: step.release === null ? state.releases : [...state.releases, step.release],
        tail: step.tail,
      };
    },
    { releases: [], tail: holdTail(offset) },
  );

describe("held tail", () => {
  it("releases every byte exactly once, in order, however the stream is chunked", () => {
    fc.assert(
      fc.property(
        streamArbitrary,
        fc.array(fc.nat(), { maxLength: 20 }),
        fc.nat({ max: 5000 }),
        ({ bytes }, cuts, offset) => {
          const { releases, tail } = feed(offset, chunksOf(bytes, cuts));
          const rest = releaseAll(tail);
          const pieces = rest === null ? releases : [...releases, rest];

          let position = offset;

          for (const piece of pieces) {
            expect(piece.offset).toBe(position);
            position += piece.bytes.length;
          }

          expect(position).toBe(offset + bytes.length);
          expect(
            pieces.reduce<Uint8Array>(
              (all, piece) => concatBytes(all, piece.bytes),
              new Uint8Array(),
            ),
          ).toEqual(bytes);
        },
      ),
    );
  });

  it("holds the last two fragments until the stream ends", () => {
    fc.assert(
      fc.property(
        streamArbitrary,
        fc.array(fc.nat(), { maxLength: 20 }),
        ({ bytes, moofs }, cuts) => {
          const { releases, tail } = feed(0, chunksOf(bytes, cuts));
          const released = releases.reduce((sum, piece) => sum + piece.bytes.length, 0);

          expect(released).toBe(moofs.length >= 2 ? (moofs.at(-2) ?? 0) : 0);
          expect(tail.offset).toBe(released);
        },
      ),
    );
  });

  it("rejects a box whose size cannot be right", () => {
    const broken = box("moof", 4, false);

    new DataView(broken.buffer).setUint32(0, 4);
    expect(TailStep.$is("Invalid")(addToTail(holdTail(100), broken))).toBe(true);
  });
});
