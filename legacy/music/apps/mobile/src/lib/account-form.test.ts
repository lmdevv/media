import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { accountFailureLine, passwordProblem } from "./account-form";

describe("passwordProblem", () => {
  it("asks for at least 8 characters", () => {
    expect(passwordProblem("1234567")).toBe("Use at least 8 characters.");
    expect(passwordProblem("12345678")).toBeNull();
  });
});

describe("accountFailureLine", () => {
  it("reads a refused sign-up as an email that already has an account", () => {
    const refused = new ConvexError({
      code: "unauthenticated",
      message: "Invalid email or password",
    });

    expect(accountFailureLine(refused)).toBe(
      "That email already has an account here. Sign in instead.",
    );
  });

  it("shows the server's own explanation, else a generic line", () => {
    const closed = new ConvexError({ code: "signup_closed", message: "This invite has expired" });

    expect(accountFailureLine(closed)).toBe("This invite has expired");
    expect(accountFailureLine(new Error("socket closed"))).toBe("Something went wrong. Try again.");
    expect(accountFailureLine("nope")).toBe("Something went wrong. Try again.");
  });
});
