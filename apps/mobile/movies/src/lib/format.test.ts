import { describe, expect, it } from "vitest";

import type { Progress } from "./catalog";
import {
  episodeCode,
  facts,
  formatRemaining,
  formatRuntime,
  progressFraction,
  progressLabel,
} from "./format";

const progress = (positionMs: number, durationMs: number, watched = false): Progress => ({
  positionMs,
  durationMs,
  watched,
  updatedAt: 0,
});

describe("format", () => {
  it("writes running times the way Paper does", () => {
    expect(formatRuntime(166 * 60_000)).toBe("2h 46m");
    expect(formatRuntime(52 * 60_000)).toBe("52m");
    expect(formatRuntime(180 * 60_000)).toBe("3h 0m");
  });

  it("pads minutes after hours in time left", () => {
    expect(formatRemaining(63 * 60_000)).toBe("1h 03m left");
    expect(formatRemaining(41 * 60_000)).toBe("41m left");
    expect(formatRemaining(-5)).toBe("0m left");
  });

  it("labels progress as watched, time left, or nothing", () => {
    expect(progressLabel(null)).toBeUndefined();
    expect(progressLabel(progress(10, 100, true))).toBe("Watched");
    expect(progressLabel(progress(11 * 60_000, 52 * 60_000))).toBe("41m left");
  });

  it("measures progress as a fraction of the running time", () => {
    expect(progressFraction(null)).toBeNull();
    expect(progressFraction(progress(30, 0))).toBeNull();
    expect(progressFraction(progress(25, 100))).toBe(0.25);
    expect(progressFraction(progress(120, 100))).toBe(1);
  });

  it("joins only the present facts", () => {
    expect(facts(2024, null, "PG-13", "", undefined)).toBe("2024 · PG-13");
    expect(episodeCode({ seasonNumber: 2, episodeNumber: 4 })).toBe("S2:E4");
  });
});
