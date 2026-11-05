import { ConvexError } from "convex/values";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isUnlockCode } from "../../../convex/core/devices/unlockCodes";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  checkNewPassword,
  checkTypedPassword,
  hashUnlockCode,
  passwordMatches,
} from "../../../convex/core/lib/passwords";

const decodeCode = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }));

const refusalOf = (check: (typed: string) => void, typed: string): string => {
  try {
    check(typed);

    return "accepted";
  } catch (cause) {
    return cause instanceof ConvexError ? decodeCode(cause.data).code : `threw ${String(cause)}`;
  }
};

const isNewPassword = (typed: string): boolean => refusalOf(checkNewPassword, typed) === "accepted";

const asPassword = (typed: string) => ({
  newPassword: refusalOf(checkNewPassword, typed),
  typedPassword: refusalOf(checkTypedPassword, typed),
});

const digitRuns = Array.from({ length: PASSWORD_MAX + 2 }, (_, length) =>
  "73914482".repeat(Math.ceil(length / 8)).slice(0, length),
);

const characters = Array.from({ length: 0x110000 }, (_, codePoint) => codePoint)
  .filter((codePoint) => codePoint < 0xd800 || codePoint > 0xdfff)
  .map((codePoint) => String.fromCodePoint(codePoint));

const DIGIT_FORMS = characters.filter((character) => /^\d$/u.test(character.normalize("NFKC")));

const typedDigits = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...DIGIT_FORMS), { minLength, maxLength, size: "max" })
    .map((forms) => forms.join(""));

const MATH_BOLD_CODE = "\u{1D7D5}\u{1D7D1}\u{1D7D7}\u{1D7CF}\u{1D7D2}\u{1D7D2}\u{1D7D6}";

describe("unlock codes", () => {
  it("are 4 to 7 digits, too short to be anyone's password", () => {
    const codes = digitRuns.filter(isUnlockCode);

    expect(codes.map((code) => code.length)).toEqual([4, 5, 6, 7]);
    expect(codes.filter(isNewPassword)).toEqual([]);
    expect(isNewPassword("73914482")).toBe(true);
    expect(isUnlockCode("73914482")).toBe(false);
  });

  it("are hashed exactly as typed, since only ASCII digits are codes", () => {
    fc.assert(
      fc.property(
        typedDigits(1, PASSWORD_MIN),
        (typed) => !isUnlockCode(typed) || typed.normalize("NFKC") === typed,
      ),
    );
  });

  it("refuse as a password every digit look-alike that Scrypt hashes as a code", async () => {
    expect(await passwordMatches(await hashUnlockCode("7391448"), MATH_BOLD_CODE)).toBe(true);
    expect(asPassword(MATH_BOLD_CODE)).toEqual({
      newPassword: "invalid_args",
      typedPassword: "accepted",
    });

    fc.assert(fc.property(typedDigits(1, PASSWORD_MIN - 1), (typed) => !isNewPassword(typed)));
  });
});

describe("password length", () => {
  it("counts the characters Scrypt hashes, so 8 to 256 digit look-alikes are a password", () => {
    fc.assert(
      fc.property(typedDigits(PASSWORD_MIN, PASSWORD_MAX), (typed) => {
        expect(asPassword(typed)).toEqual({ newPassword: "accepted", typedPassword: "accepted" });
      }),
    );
    fc.assert(
      fc.property(typedDigits(PASSWORD_MAX + 1, PASSWORD_MAX * 2), (typed) => {
        expect(asPassword(typed)).toEqual({
          newPassword: "invalid_args",
          typedPassword: "accepted",
        });
      }),
    );
  });

  it("takes the longest password typed as the letters NFKC joins most", () => {
    const longestDecomposition = characters.reduce(
      (longest, character) => Math.max(longest, Array.from(character.normalize("NFD")).length),
      0,
    );

    const typed = "ᾂ".normalize("NFD").repeat(PASSWORD_MAX);

    expect({ longestDecomposition, typed: typed.length }).toEqual({
      longestDecomposition: 4,
      typed: PASSWORD_MAX * 4,
    });
    expect(asPassword(typed)).toEqual({ newPassword: "accepted", typedPassword: "accepted" });
    expect(asPassword(`${typed}a`)).toEqual({
      newPassword: "invalid_args",
      typedPassword: "accepted",
    });
  });

  it("lets a password set when the rule counted UTF-16 units be typed, but nothing far longer", () => {
    expect(asPassword("\uFB03".repeat(100))).toEqual({
      newPassword: "invalid_args",
      typedPassword: "accepted",
    });
    expect(asPassword("x".repeat(PASSWORD_MAX * 8 + 1))).toEqual({
      newPassword: "invalid_args",
      typedPassword: "invalid_args",
    });
  });
});
