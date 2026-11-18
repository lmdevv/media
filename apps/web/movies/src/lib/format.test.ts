import { Progress } from "@media/contracts/models/catalog";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  episodeCode,
  facts,
  formatDaysFrom,
  formatRemaining,
  formatRuntime,
  plural,
  progressLabel,
} from "./format";

const progress = (positionMs: number, durationMs: number, watched = false) =>
  Schema.decodeSync(Progress)({ positionMs, durationMs, watched, updatedAt: 0 });

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

  it("joins only the present facts", () => {
    expect(facts(2024, null, "PG-13", "", undefined)).toBe("2024 · PG-13");
    expect(episodeCode({ seasonNumber: 2, episodeNumber: 4 })).toBe("S2:E4");
    expect(plural(1, "season", "seasons")).toBe("1 season");
    expect(plural(1284, "file", "files")).toBe("1,284 files");
  });
});

describe("dates", () => {
  it("writes days relative to now", () => {
    const now = Date.UTC(2026, 9, 11, 12);

    expect(formatDaysFrom(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(formatDaysFrom(now, now)).toBe("today");
  });
});
