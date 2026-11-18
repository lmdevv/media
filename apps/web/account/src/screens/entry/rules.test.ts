import { describe, expect, it } from "vitest";

import { passwordHint, passwordProblem } from "./password";
import { failureLine } from "./submission";
import { codeLetters, formatUserCode } from "./user-code";

describe("passwordProblem", () => {
  it("accepts 8 to 256 characters", () => {
    expect(passwordProblem("a".repeat(8))).toBeNull();
    expect(passwordProblem("a".repeat(256))).toBeNull();
    expect(passwordProblem("a".repeat(7))).toBe("Use 8 to 256 characters for the password.");
    expect(passwordProblem("a".repeat(257))).toBe("Use 8 to 256 characters for the password.");
  });

  it("counts characters as the core does, by code point after NFKC", () => {
    expect(passwordProblem("🔑".repeat(8))).toBeNull();
    expect(passwordHint("🔑".repeat(8))).toBe("8 characters");
    expect(passwordHint("short")).toBeUndefined();
  });
});

describe("user codes", () => {
  it("keeps the letters of a typed or pasted code", () => {
    expect(codeLetters("hdkr-bgtl")).toBe("HDKRBGTL");
    expect(codeLetters(" HDKR BGTL extra")).toBe("HDKRBGTL");
  });

  it("formats a complete code as the core shows it", () => {
    expect(formatUserCode("HDKRBGTL")).toBe("HDKR-BGTL");
    expect(formatUserCode("HDKRBGT")).toBeNull();
  });
});

describe("failureLine", () => {
  const lines = { Unauthenticated: "Wrong username or password." };

  it("uses the form's line for its tag", () => {
    expect(failureLine({ _tag: "Unauthenticated", message: "no" }, lines)).toBe(
      "Wrong username or password.",
    );
  });

  it("explains rate limiting on every form", () => {
    expect(failureLine({ _tag: "RateLimited", message: "slow" }, lines)).toBe(
      "Too many tries. Wait a few minutes, then try again.",
    );
  });

  it("falls back to the general line", () => {
    expect(failureLine(new Error("That username is taken"), lines)).toBe("That username is taken");
  });
});
