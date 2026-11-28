import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deltaE2000, HDR_PATCHES, hdrPattern, judgePatches, readPatches, REFERENCES, SDR_PATCHES, sdrPattern } from "./colour-patches.mjs";

describe("colour patches", () => {
  test("CIEDE2000 matches Sharma, Wu, and Dalal's test pairs", () => {
    const pairs = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
      [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    ];
    for (const [left, right, expected] of pairs) assert.ok(Math.abs(deltaE2000(left, right) - expected) < 1e-3, `${left} ${right}`);
  });

  test("reads back the patches it draws", () => {
    const sdr = sdrPattern();
    const frame = Buffer.concat([sdr, Buffer.alloc(1920 * 440 * 3)]);
    const read = readPatches(frame, 1920, SDR_PATCHES.length);
    assert.deepEqual(read, SDR_PATCHES.map((patch) => patch.rgb));
    assert.equal(hdrPattern(100).length, 1920 * 640 * 3 * 4);
    assert.equal(REFERENCES.hdr10.length, HDR_PATCHES.length);
    assert.equal(REFERENCES.hlg.length, HDR_PATCHES.length);
  });

  test("passes the reference and a slightly brighter curve; fails a crushed black, clipped highlights, a cast, and a range fault", () => {
    const reference = REFERENCES.hdr10;
    const tolerance = { deltaE: 10, dark: 8 };
    assert.equal(judgePatches(reference, reference, HDR_PATCHES, tolerance).ok, true);
    const brighter = reference.map((rgb) => rgb.map((value) => Math.min(255, value + 4)));
    assert.equal(judgePatches(brighter, reference, HDR_PATCHES, tolerance).ok, true, judgePatches(brighter, reference, HDR_PATCHES, tolerance).evidence);
    const crushed = reference.map((rgb, index) => (HDR_PATCHES[index].kind === "dark" ? rgb.map((value) => Math.max(0, value - 12)) : rgb));
    const crush = judgePatches(crushed, reference, HDR_PATCHES, tolerance);
    assert.equal(crush.ok, false);
    assert.match(crush.evidence, /gray 0.1 and gray 0.5 merge|luma/);
    const clipped = reference.map((rgb) => rgb.map((value) => Math.min(255, value * 1.1)));
    assert.match(judgePatches(clipped, reference, HDR_PATCHES, tolerance).evidence, /gray 400 and gray 700 merge/);
    const green = reference.map(([r, g, b]) => [r * 0.85, Math.min(255, g * 1.1), b * 0.85]);
    assert.equal(judgePatches(green, reference, HDR_PATCHES, tolerance).ok, false);
    const limitedAsFull = reference.map((rgb) => rgb.map((value) => 16 + (value * 219) / 255));
    assert.equal(judgePatches(limitedAsFull, reference, HDR_PATCHES, tolerance).ok, false);
  });
});
