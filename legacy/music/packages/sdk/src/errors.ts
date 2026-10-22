import { ConvexError } from "convex/values";
import { Option, Schema } from "effect";

const FailureData = Schema.Struct({ code: Schema.String, message: Schema.String });

const decodeFailureData = Schema.decodeUnknownOption(FailureData);

/** An expected failure from the server: a code to branch on and a message to show. */
export interface CommandFailure {
  readonly code: string;
  readonly message: string;
}

/** Reads the server's expected-failure payload from a thrown error, if it carries one. */
export const commandFailure = (error: Error): CommandFailure | null => {
  if (!(error instanceof ConvexError)) return null;

  return Option.getOrNull(decodeFailureData(error.data));
};

/** A message safe to show to the user for any thrown value. */
export const errorMessage = (error: Error): string =>
  commandFailure(error)?.message ?? "Something went wrong. Try again.";

/**
 * Why the server refused a session: the account was suspended or removed, or the session itself
 * ended (signed out elsewhere, a password reset, an expired token).
 */
export type SessionEnd = "suspended" | "removed" | "ended";

const RefusedData = Schema.Struct({
  code: Schema.Literal("unauthenticated"),
  reason: Schema.optional(Schema.Unknown),
});

const decodeRefusedData = Schema.decodeUnknownOption(RefusedData);

/** Why a refused session ended, or null when `error` is not a refused session. */
export const sessionEnd = (error: Error): SessionEnd | null => {
  if (!(error instanceof ConvexError)) return null;

  return Option.match(decodeRefusedData(error.data), {
    onNone: () => null,
    // A reason this client doesn't know still means the session is over.
    onSome: ({ reason }) => (reason === "suspended" || reason === "removed" ? reason : "ended"),
  });
};
