import { describe, expect, it } from "vitest";

import { dayLabel, distinctSongs, historyRows } from "./history";
import { trackOf } from "./test-fixtures";

const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime();

const now = at(2026, 10, 22, 9);

describe("distinctSongs", () => {
  it("lists each song once at its latest play, newest first", () => {
    const angel = trackOf("Angel");
    const roads = trackOf("Roads", "Portishead");

    const plays = [angel, angel, roads, angel, trackOf("Teardrop")].map((track, index) => ({
      track,
      playedAt: now - index,
    }));

    expect(distinctSongs(plays, 5).map((track) => track.title)).toEqual([
      "Angel",
      "Roads",
      "Teardrop",
    ]);
    expect(distinctSongs(plays, 2).map((track) => track.title)).toEqual(["Angel", "Roads"]);
  });
});

describe("dayLabel", () => {
  it("names recent days and dates older ones", () => {
    expect(dayLabel(at(2026, 10, 22, 0), now)).toBe("Today");
    expect(dayLabel(at(2026, 10, 21, 0), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 10, 19, 0), now)).toBe("Monday");
    expect(dayLabel(at(2026, 10, 2, 0), now)).toBe("Oct 2");
    expect(dayLabel(at(2025, 12, 31, 0), now)).toBe("Dec 31, 2025");
  });
});

describe("historyRows", () => {
  it("puts a heading over each day's plays and keeps every play", () => {
    const plays = [
      { track: trackOf("Unfinished Sympathy"), playedAt: at(2026, 10, 22, 8) },
      { track: trackOf("Unfinished Sympathy"), playedAt: at(2026, 10, 22, 7) },
      { track: trackOf("All I Need", "Radiohead"), playedAt: at(2026, 10, 21, 23) },
    ];

    const rows = historyRows(plays, now);

    expect(rows.map((row) => (row.kind === "day" ? row.label : row.play.track.title))).toEqual([
      "Today",
      "Unfinished Sympathy",
      "Unfinished Sympathy",
      "Yesterday",
      "All I Need",
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows.flatMap((row) => (row.kind === "play" ? [row.index] : []))).toEqual([0, 1, 2]);
  });
});
