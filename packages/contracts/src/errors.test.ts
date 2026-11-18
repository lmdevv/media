import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CommandFailure,
  commandError,
  Conflict,
  Expired,
  Forbidden,
  Internal,
  InvalidArgs,
  NotFound,
  RateLimited,
  Unauthenticated,
} from "./errors";
import type { ErrorCode } from "./errors";

const decodeFailure = Schema.decodeUnknownSync(CommandFailure);

const message = "Sign in first";

const expected: ReadonlyArray<readonly [ErrorCode, unknown]> = [
  ["unauthenticated", new Unauthenticated({ message })],
  ["forbidden", new Forbidden({ message })],
  ["not_found", new NotFound({ message })],
  ["invalid_args", new InvalidArgs({ message })],
  ["conflict", new Conflict({ message })],
  ["expired", new Expired({ message })],
  ["rate_limited", new RateLimited({ message })],
  ["internal", new Internal({ message })],
];

describe("commandError", () => {
  it.each(expected)("turns %s into its tagged error", (code, error) => {
    expect(commandError(decodeFailure({ code, message }))).toStrictEqual(error);
  });

  it("carries the request ID of the media service answer it came from", () => {
    const error = commandError(decodeFailure({ code: "forbidden", message }), {
      requestId: "0b6f3c1e-5d2a-4e8f-9a7b-3c4d5e6f7a81",
    });

    expect(error).toStrictEqual(
      new Forbidden({ message, requestId: "0b6f3c1e-5d2a-4e8f-9a7b-3c4d5e6f7a81" }),
    );
    expect(error).toHaveProperty("requestId", "0b6f3c1e-5d2a-4e8f-9a7b-3c4d5e6f7a81");
  });

  it("rejects unknown codes at the wire boundary", () => {
    expect(() => decodeFailure({ code: "teapot", message: "no" })).toThrow();
  });
});
