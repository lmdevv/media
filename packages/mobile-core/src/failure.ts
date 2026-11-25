import type { CommandError } from "@media/contracts/errors";
import type { Release } from "@media/contracts/release";
import { Option, Predicate } from "effect";

import { rereadAfter, updateLine, updateLineAgainst } from "./server-release";

/** The tag of an expected command failure, such as `Unauthenticated` or `Expired`. */
export type FailureTag = CommandError["_tag"];

/** Whether `cause` is the expected command failure tagged `tag`. */
export const isFailure = (cause: unknown, tag: FailureTag): boolean =>
  Predicate.isTagged(cause, tag);

const SOMETHING_WENT_WRONG = "Something went wrong. Try again.";

/**
 * The line for a server answer this app can't read. It asks to update the app while the server
 * runs a newer release, and stays generic otherwise, since matching releases mean a bug. A screen
 * that read the server's release itself passes it as `seen`, and that release alone decides the
 * line; without one, the release the app last read does.
 */
export const describeUnreadable = (seen: Option.Option<Release> = Option.none()): string =>
  (Option.isSome(seen) ? updateLineAgainst(seen) : updateLine()) ?? SOMETHING_WENT_WRONG;

/** The line to show for any failure of a command or sign-in. */
export const describeFailure = (cause: unknown): string => {
  if (Predicate.isTagged(cause, "TransportError")) {
    return "Can't reach the server. Check the connection and try again.";
  }

  if (Predicate.isTagged(cause, "KeychainWriteFailed")) {
    return "This iPhone couldn’t save your sign-in. Unlock it and try again.";
  }

  if (Predicate.isTagged(cause, "ProtocolError")) {
    rereadAfter(cause);

    return describeUnreadable();
  }

  if (Predicate.isTagged(cause, "TokenStorageError")) return SOMETHING_WENT_WRONG;

  return cause instanceof Error && cause.message !== "" ? cause.message : SOMETHING_WENT_WRONG;
};
