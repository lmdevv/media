import { describe, expect, it } from "vitest";

import { ago, dayOf, until } from "./when";

const now = new Date(2026, 9, 22, 15, 0).getTime();

const minutes = (count: number) => count * 60_000;

const hours = (count: number) => count * minutes(60);

const days = (count: number) => count * hours(24);

describe("ago", () => {
  it("words recent times as Paper's key rows do", () => {
    expect(ago(now - 20_000, now)).toBe("just now");
    expect(ago(now - minutes(1), now)).toBe("1 minute ago");
    expect(ago(now - minutes(12), now)).toBe("12 minutes ago");
    expect(ago(now - hours(3), now)).toBe("3 hours ago");
    expect(ago(now - hours(30), now)).toBe("yesterday");
    expect(ago(now - days(3), now)).toBe("3 days ago");
  });

  it("falls back to a date after a week", () => {
    expect(ago(new Date(2026, 9, 2).getTime(), now)).toBe("on 2 Oct");
  });
});

describe("until", () => {
  it("words what is left before an expiry", () => {
    expect(until(now + days(5), now)).toBe("in 5 days");
    expect(until(now + days(1), now)).toBe("in 1 day");
    expect(until(now + hours(23), now)).toBe("in 23 hours");
    expect(until(now + 10_000, now)).toBe("in 1 minute");
  });

  it("is null once the time has passed", () => {
    expect(until(now - 1, now)).toBeNull();
  });
});

describe("dayOf", () => {
  it("names today and yesterday by calendar day, not elapsed time", () => {
    expect(dayOf(new Date(2026, 9, 22, 0, 5).getTime(), now)).toBe("Today");
    expect(dayOf(new Date(2026, 9, 21, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(dayOf(new Date(2026, 9, 20, 12).getTime(), now)).toBe("20 Oct");
  });
});
