import { COVER_SIZES } from "@media/contracts/artwork";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { webCoverSize } from "./cover-size";

describe("webCoverSize", () => {
  it("asks for the copy of exactly a cover's drawn size", () => {
    for (const size of COVER_SIZES) expect(webCoverSize(size)).toBe(size);
  });

  it("asks for a copy the browser shrinks sharply, never one 2 to 2.8 times the box", () => {
    // A grid card and an album header at density 1, and a 40-pixel row.
    expect([166, 232, 40].map(webCoverSize)).toEqual([480, 336, 120]);
    fc.assert(
      fc.property(fc.double({ min: 1, max: 2000, noNaN: true }), (pixels) => {
        const size = webCoverSize(pixels);

        if (size === undefined || size === Math.round(pixels)) return;
        const octave = Math.log2(size / pixels);

        expect(octave).toBeGreaterThanOrEqual(0.5);
        expect(octave % 1).toBeGreaterThanOrEqual(0.5);
      }),
    );
  });

  it("asks for the original when no copy is the box's size or shrinks sharply into it", () => {
    expect(webCoverSize(1300)).toBeUndefined();
    expect(webCoverSize(Number.NaN)).toBeUndefined();
  });
});
