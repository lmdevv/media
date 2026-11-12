import type { CommandError } from "@media/contracts/errors";
import { Predicate } from "effect";

/** The tag of an expected command failure, such as `Unauthenticated` or `Expired`. */
export type FailureTag = CommandError["_tag"];

/** Whether `cause` is the expected command failure tagged `tag`. */
export const isFailure = (cause: unknown, tag: FailureTag): boolean =>
  Predicate.isTagged(cause, tag);

/** The line to show for any failure of a command or sign-in. */
export const describeFailure = (cause: unknown): string => {
  if (Predicate.isTagged(cause, "TransportError")) {
    return "Can't reach the server. Check the connection and try again.";
  }

  if (Predicate.isTagged(cause, "KeychainWriteFailed")) {
    return "This iPhone couldn’t save your sign-in. Unlock it and try again.";
  }

  if (
    Predicate.isTagged(cause, "ProtocolError") ||
    Predicate.isTagged(cause, "TokenStorageError")
  ) {
    return "Something went wrong. Try again.";
  }

  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : "Something went wrong. Try again.";
};
