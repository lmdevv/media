import { describe, expect, it } from "vitest";

import { isUnlockCode } from "../../../convex/core/devices/unlockCodes";
import { PASSWORD_MAX, checkNewPassword } from "../../../convex/core/lib/passwords";

const isNewPassword = (typed: string): boolean => {
  try {
    checkNewPassword(typed);

    return true;
  } catch {
    return false;
  }
};

const digitRuns = Array.from({ length: PASSWORD_MAX + 2 }, (_, length) =>
  "73914482".repeat(Math.ceil(length / 8)).slice(0, length),
);

describe("unlock codes", () => {
  it("are 4 to 7 digits, too short to be anyone's password", () => {
    const codes = digitRuns.filter(isUnlockCode);

    expect(codes.map((code) => code.length)).toEqual([4, 5, 6, 7]);
    expect(codes.filter(isNewPassword)).toEqual([]);
    expect(isNewPassword("73914482")).toBe(true);
    expect(isUnlockCode("73914482")).toBe(false);
  });
});
