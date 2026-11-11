import { describe, expect, it } from "vitest";

import { dayLabel, daysAgo, shortDate } from "./dates";

const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime();

describe("dates", () => {
  const now = at(2026, 10, 17, 9);

  it("counts calendar days, not 24-hour spans", () => {
    expect(daysAgo(at(2026, 10, 17, 0), now)).toBe(0);
    expect(daysAgo(at(2026, 10, 16, 23), now)).toBe(1);
    expect(daysAgo(at(2026, 10, 10, 1), now)).toBe(7);
    expect(daysAgo(at(2026, 10, 18), now)).toBe(-1);
  });

  it("says when something happened", () => {
    expect(dayLabel(at(2026, 10, 17, 1), now)).toBe("Today");
    expect(dayLabel(at(2026, 10, 16), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 10, 14), now)).toBe("3 days ago");
    expect(dayLabel(at(2026, 10, 2), now)).toBe("Oct 2");
    expect(dayLabel(at(2025, 10, 2), now)).toBe("Oct 2, 2025");
    expect(shortDate(at(2026, 1, 31), now)).toBe("Jan 31");
  });
});
