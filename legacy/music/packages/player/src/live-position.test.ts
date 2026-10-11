import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { livePosition } from "./live-position";

const millis = fc.integer({ min: 0, max: 3_600_000 });

describe("livePosition", () => {
  it("adds the time since the report while playing", () => {
    expect(livePosition({ positionMs: 1000, updatedAt: 10_000, playing: true }, 12_500, 0)).toBe(
      3500,
    );
  });

  it("stays put while paused", () => {
    expect(livePosition({ positionMs: 1000, updatedAt: 10_000, playing: false }, 99_000, 0)).toBe(
      1000,
    );
  });

  it("ignores a report from the future (clock skew)", () => {
    expect(livePosition({ positionMs: 1000, updatedAt: 20_000, playing: true }, 10_000, 0)).toBe(
      1000,
    );
  });

  it("never leaves [0, duration] and never moves backwards in time", () => {
    fc.assert(
      fc.property(
        millis,
        millis,
        millis,
        millis,
        millis,
        (positionMs, updatedAt, elapsed, later, durationMs) => {
          const snapshot = { positionMs, updatedAt, playing: true };
          const now = updatedAt + elapsed;
          const first = livePosition(snapshot, now, durationMs);
          const second = livePosition(snapshot, now + later, durationMs);

          expect(first).toBeGreaterThanOrEqual(0);

          if (durationMs > 0) expect(first).toBeLessThanOrEqual(durationMs);
          expect(second).toBeGreaterThanOrEqual(first);
        },
      ),
    );
  });
});
