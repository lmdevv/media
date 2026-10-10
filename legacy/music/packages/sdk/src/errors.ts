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
