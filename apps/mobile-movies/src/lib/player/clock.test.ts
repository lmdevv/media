import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatClock, formatTimeLeft } from "./clock";

describe("formatClock", () => {
  it("writes minutes and seconds, adding hours past one", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(24 * 60 + 18)).toBe("24:18");
    expect(formatClock(3600 + 2 * 60 + 44)).toBe("1:02:44");
    expect(formatClock(5598)).toBe("1:33:18");
  });

  it("holds odd input at zero", () => {
    expect(formatClock(-3)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("reads back the seconds it wrote", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 * 3600 }), (seconds) => {
        const parts = formatClock(seconds).split(":").map(Number);
        const read = parts.reduce((total, part) => total * 60 + part, 0);

        expect(read).toBe(seconds);
      }),
    );
  });
});

describe("formatTimeLeft", () => {
  it("counts down to the end with a minus sign", () => {
    expect(formatTimeLeft(5598, 5598 + 4364)).toBe("−1:12:44");
    expect(formatTimeLeft(10, 10)).toBe("−0:00");
    expect(formatTimeLeft(12, 10)).toBe("−0:00");
  });
});
