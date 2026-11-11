import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SUBTITLE_DELAY, clampSubtitleDelay, formatSubtitleDelay } from "./subtitle-delay";

describe("clampSubtitleDelay", () => {
  it("rounds to a step and holds the range", () => {
    expect(clampSubtitleDelay(149)).toBe(100);
    expect(clampSubtitleDelay(-49)).toBe(0);
    expect(Object.is(clampSubtitleDelay(-49), -0)).toBe(false);
    expect(clampSubtitleDelay(45_000)).toBe(30_000);
    expect(clampSubtitleDelay(Number.NaN)).toBe(0);
  });

  it("always lands on a step within the range, and stays there", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (ms) => {
        const delay = clampSubtitleDelay(ms);

        expect(Math.abs(delay)).toBeLessThanOrEqual(SUBTITLE_DELAY.maxMs);
        expect(Math.abs(delay % SUBTITLE_DELAY.stepMs)).toBe(0);
        expect(clampSubtitleDelay(delay)).toBe(delay);
      }),
    );
  });
});

describe("formatSubtitleDelay", () => {
  it("signs a delay in seconds", () => {
    expect(formatSubtitleDelay(0)).toBe("0.0 s");
    expect(formatSubtitleDelay(500)).toBe("+0.5 s");
    expect(formatSubtitleDelay(-1200)).toBe("−1.2 s");
  });
});
