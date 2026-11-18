import { Conflict, Expired } from "@media/contracts/errors";
import { describe, expect, it } from "vitest";

import { accountFailureLine, passwordProblem } from "./account-form";

describe("passwordProblem", () => {
  it("asks for 8 to 256 characters, counted in their NFKC form", () => {
    expect(passwordProblem("1234567")).toBe("Use at least 8 characters.");
    expect(passwordProblem("12345678")).toBeNull();
    expect(passwordProblem("x".repeat(257))).toBe("Use at most 256 characters.");
    expect(passwordProblem("ﬀﬀﬀﬀ")).toBeNull();
  });
});

describe("accountFailureLine", () => {
  it("reads a conflict as a username already taken", () => {
    expect(accountFailureLine(new Conflict({ message: "Username taken" }))).toBe(
      "That username is taken. Pick another.",
    );
  });

  it("shows the core's own explanation, else a generic line", () => {
    expect(accountFailureLine(new Expired({ message: "This invite has expired" }))).toBe(
      "This invite has expired",
    );
    expect(accountFailureLine("nope")).toBe("Something went wrong. Try again.");
  });
});
