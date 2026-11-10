import { describe, expect, it } from "vitest";

import { formatAgo, formatBytes, formatDate, formatSpan, formatUntil, plural } from "./format";

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();

const MINUTE = 60_000;

const DAY = 24 * 60 * MINUTE;

describe("formatAgo", () => {
  it("reads like the API keys table", () => {
    expect(formatAgo(NOW - 20_000, NOW)).toBe("just now");
    expect(formatAgo(NOW - 2 * MINUTE, NOW)).toBe("2 min ago");
    expect(formatAgo(NOW - 61 * MINUTE, NOW)).toBe("1 hr ago");
    expect(formatAgo(NOW - DAY - MINUTE, NOW)).toBe("Yesterday");
    expect(formatAgo(NOW - 41 * DAY, NOW)).toBe("41 days ago");
  });

  it("treats times slightly in the future as now", () => {
    expect(formatAgo(NOW + 5_000, NOW)).toBe("just now");
  });
});

describe("formatUntil", () => {
  it("rounds minutes up so a live code never shows 0 min", () => {
    expect(formatUntil(NOW + 30_000, NOW)).toBe("in 1 min");
    expect(formatUntil(NOW + 7 * MINUTE + 1, NOW)).toBe("in 8 min");
    expect(formatUntil(NOW + 5 * DAY, NOW)).toBe("in 5 days");
    expect(formatUntil(NOW - 1, NOW)).toBe("now");
  });
});

describe("formatBytes", () => {
  it("uses decimal units with one decimal for large sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(182_000_000)).toBe("182 MB");
    expect(formatBytes(9_800_000_000)).toBe("9.8 GB");
    expect(formatBytes(4_100_000_000_000)).toBe("4.1 TB");
    expect(formatBytes(612_000_000_000)).toBe("612 GB");
  });
});

describe("dates and counts", () => {
  it("drops the year only for the current year", () => {
    expect(formatDate(new Date(2026, 7, 2, 12).getTime(), NOW)).toBe("Aug 2");
    expect(formatDate(new Date(2025, 2, 4, 12).getTime(), NOW)).toBe("Mar 4, 2025");
  });

  it("pluralizes with separators", () => {
    expect(plural(1, "title")).toBe("1 title");
    expect(plural(1312, "title")).toBe("1,312 titles");
  });

  it("prints spans in their largest unit", () => {
    expect(formatSpan(45_000)).toBe("45s");
    expect(formatSpan(4 * MINUTE + 10_000)).toBe("4m");
    expect(formatSpan(125 * MINUTE)).toBe("2h");
  });
});
