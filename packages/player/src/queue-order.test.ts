import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { followingIndex, nextIndex, previousIndex, RESTART_THRESHOLD_MS } from "./queue-order";
import type { RepeatMode } from "./queue-order";

const repeat = fc.constantFrom<RepeatMode>("off", "all", "one");

describe("nextIndex", () => {
  it("moves on, and past the end only when repeat is all", () => {
    expect(nextIndex(0, 3, "off")).toBe(1);
    expect(nextIndex(2, 3, "off")).toBeNull();
    expect(nextIndex(2, 3, "one")).toBeNull();
    expect(nextIndex(2, 3, "all")).toBe(0);
    expect(nextIndex(0, 0, "all")).toBeNull();
  });

  it("always lands inside the queue", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), repeat, (length, mode) => {
        for (const index of [0, length - 1]) {
          const next = nextIndex(index, length, mode);

          expect(next === null || (next >= 0 && next < length)).toBe(true);
        }
      }),
    );
  });
});

describe("previousIndex", () => {
  it("starts the song again once it played past the threshold", () => {
    expect(previousIndex(RESTART_THRESHOLD_MS + 1, 2, 3, "off")).toBe(2);
  });

  it("goes back, and wraps at the top only when repeat is all", () => {
    expect(previousIndex(0, 2, 3, "off")).toBe(1);
    expect(previousIndex(0, 0, 3, "off")).toBe(0);
    expect(previousIndex(0, 0, 3, "all")).toBe(2);
  });
});

describe("followingIndex", () => {
  it("loads nothing ahead while repeat one plays the song again", () => {
    expect(followingIndex(0, 3, "one")).toBeNull();
    expect(followingIndex(0, 3, "off")).toBe(1);
    expect(followingIndex(2, 3, "all")).toBe(0);
  });
});
