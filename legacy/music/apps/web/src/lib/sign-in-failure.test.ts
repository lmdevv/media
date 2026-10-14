import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { convexLogger } from "./convex-logger";
import { signInFailure } from "./sign-in-failure";

const failures = [
  "[CONVEX A(auth:signIn)] [Request ID: 1] Server Error\nUncaught Error: InvalidSecret",
  "[CONVEX A(auth:signIn)] [Request ID: 2] Server Error\nUncaught Error: InvalidAccountId",
  "[CONVEX A(auth:signIn)] [Request ID: 3] Server Error\nUncaught Error: Invalid refresh token",
  "[CONVEX A(auth:signIn)] [Request ID: 4] Server Error",
  '[CONVEX A(auth:signIn)] [Request ID: 5] Server Error\nUncaught ConvexError: {"code":"unauthenticated","message":"Session expired"}',
];

describe("signInFailure", () => {
  it("reads only InvalidAccountId and InvalidSecret as a wrong email or password", () => {
    expect(signInFailure(new Error("Uncaught Error: InvalidSecret"))).toBe("credentials");
    expect(signInFailure(new Error("Uncaught Error: InvalidAccountId"))).toBe("credentials");
  });

  it("reads Convex Auth's rate limit as too many attempts", () => {
    expect(signInFailure(new Error("Uncaught Error: TooManyFailedAttempts"))).toBe("rate-limited");
  });

  it("reads anything else as a server problem, including other unauthenticated failures", () => {
    expect(signInFailure(new Error("[Request ID: 5f0a3c] Server Error"))).toBe("server");
    expect(signInFailure(new Error("Missing environment variable JWT_PRIVATE_KEY"))).toBe("server");
    expect(
      signInFailure(new ConvexError({ code: "unauthenticated", message: "Session expired" })),
    ).toBe("server");
  });

  it("agrees with the Convex logger on which sign-in failures are the user's input", () => {
    const logged: Array<unknown> = [];

    const logger = convexLogger({
      log: () => undefined,
      warn: () => undefined,
      error: (line) => void logged.push(line),
    });

    for (const line of failures) logger.error(line);

    const quiet = failures.filter((line) => !logged.includes(line));

    expect(quiet).toEqual(
      failures.filter((line) => signInFailure(new Error(line)) === "credentials"),
    );
  });
});
