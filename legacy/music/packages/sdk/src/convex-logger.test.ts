import { describe, expect, it } from "vitest";

import { convexLogger } from "./convex-logger";
import type { LogSink } from "./convex-logger";

/** A sink that records what reaches each console method. */
const recordingSink = () => {
  const lines: Array<readonly [level: string, args: ReadonlyArray<unknown>]> = [];

  const sink: LogSink = {
    log: (...args) => void lines.push(["log", args]),
    warn: (...args) => void lines.push(["warn", args]),
    error: (...args) => void lines.push(["error", args]),
  };

  return { lines, sink };
};

const signInFailure = (error: string) =>
  `[CONVEX A(auth:signIn)] [Request ID: c567abd5af572dac] Server Error\nUncaught Error: ${error}\n    at retrieveAccount (index.ts:602:9)`;

describe("convexLogger", () => {
  it("drops a sign-in rejected for its email or password", () => {
    const { lines, sink } = recordingSink();
    const logger = convexLogger(sink);

    logger.error(signInFailure("InvalidSecret"));
    logger.error(signInFailure("InvalidAccountId"));

    expect(lines).toEqual([]);
  });

  it("still logs other sign-in failures and every other function's errors", () => {
    const { lines, sink } = recordingSink();
    const logger = convexLogger(sink);

    const refresh = signInFailure("Invalid refresh token");
    const limited = signInFailure("TooManyFailedAttempts");
    const redacted = "[CONVEX A(auth:signIn)] [Request ID: 5f0a3c] Server Error";

    const other =
      "[CONVEX M(commands:run)] [Request ID: 1] Server Error\nUncaught Error: InvalidSecret";

    logger.error(refresh);
    logger.error(limited);
    logger.error(redacted);
    logger.error(other);
    logger.warn("reconnecting");
    logger.log("%c[CONVEX Q(commands:read)] [LOG]", "color:gray", "'hello'");

    expect(lines).toEqual([
      ["error", [refresh]],
      ["error", [limited]],
      ["error", [redacted]],
      ["error", [other]],
      ["warn", ["reconnecting"]],
      ["log", ["%c[CONVEX Q(commands:read)] [LOG]", "color:gray", "'hello'"]],
    ]);
  });
});
