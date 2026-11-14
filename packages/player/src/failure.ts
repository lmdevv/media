import { Predicate } from "effect";

/** The line the player shows for a failed call, as the music client shows every failure. */
export const messageOf = (cause: unknown): string => {
  if (Predicate.isTagged(cause, "TransportError")) {
    return "Can't reach the server. Check the connection and try again.";
  }

  if (Predicate.isTagged(cause, "ProtocolError")) return "Something went wrong. Try again.";

  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : "Something went wrong. Try again.";
};
