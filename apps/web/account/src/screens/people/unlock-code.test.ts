import { describe, expect, it } from "vitest";

import { codeDigits, isUnlockCode } from "./unlock-code";

describe("isUnlockCode", () => {
  it("takes 4 to 7 ASCII digits", () => {
    expect(["1234", "12345", "1234567"].map(isUnlockCode)).toEqual([true, true, true]);
  });

  it("refuses shorter, longer, and non-digit codes", () => {
    expect(["", "123", "12345678", "12a4", "１２３４", "𝟕𝟑𝟗𝟏"].map(isUnlockCode)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("codeDigits", () => {
  it("keeps up to 7 ASCII digits of what was typed", () => {
    expect(codeDigits("12-34 56789")).toBe("1234567");
    expect(codeDigits("１２a3")).toBe("3");
  });
});
