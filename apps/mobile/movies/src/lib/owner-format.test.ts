import { describe, expect, it } from "vitest";

import { countOf, formatBytes, formatCount, formatPercent, formatWhen } from "./owner-format";

const at = (year: number, month: number, day: number, hours: number, minutes: number): number =>
  new Date(year, month - 1, day, hours, minutes).getTime();

describe("owner format", () => {
  it("separates thousands and names counts in the right number", () => {
    expect(formatCount(1842)).toBe("1,842");
    expect(formatCount(186)).toBe("186");
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(countOf(1, "Title", "Titles")).toBe("1 Title");
    expect(countOf(1312, "Title", "Titles")).toBe("1,312 Titles");
  });

  it("names moments today, yesterday, this year, and before", () => {
    const now = at(2026, 10, 17, 20, 0);

    expect(formatWhen(at(2026, 10, 17, 15, 12), now)).toBe("Today, 3:12 PM");
    expect(formatWhen(at(2026, 10, 16, 15, 8), now)).toBe("Yesterday, 3:08 PM");
    expect(formatWhen(at(2026, 10, 15, 3, 0), now)).toBe("October 15, 3:00 AM");
    expect(formatWhen(at(2026, 10, 15, 0, 5), now)).toBe("October 15, 12:05 AM");
    expect(formatWhen(at(2025, 3, 4, 12, 30), now)).toBe("March 4, 2025, 12:30 PM");
  });

  it("writes sizes in decimal units and fractions as percentages", () => {
    expect(formatBytes(842_000_000)).toBe("842 MB");
    expect(formatBytes(4_200_000_000_000)).toBe("4.2 TB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatPercent(0.684)).toBe("68%");
    expect(formatPercent(1.2)).toBe("100%");
  });
});
