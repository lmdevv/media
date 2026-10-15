import { describe, expect, it } from "vitest";

import { clockOffset, withClockSample } from "./clock-offset";

const none: ReadonlyArray<number> = [];

describe("clockOffset", () => {
  it("takes the sample that waited least, over the recent ones", () => {
    // A clock 1.5 s fast, with deliveries taking 80 to 400 ms.
    const samples = [1900, 1580, 1650, 1720].reduce(withClockSample, none);

    expect(clockOffset(samples)).toBe(1580);
  });

  it("forgets old samples, so it follows a clock that was corrected", () => {
    const before = Array.from({ length: 8 }, () => 5000).reduce(withClockSample, none);

    const after = Array.from({ length: 8 }, () => 100).reduce(withClockSample, before);

    expect(clockOffset(after)).toBe(100);
    expect(clockOffset([])).toBe(0);
  });
});
