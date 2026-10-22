import { ConvexError } from "convex/values";

/** Expected failures a caller can act on. Clients read `data.code` and show `data.message`. */
export type FailureCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_args"
  | "conflict"
  | "signup_closed"
  | "rate_limited"
  | "internal";

/** Throws a `ConvexError`, Convex's transport for expected failures. */
export const fail = (code: FailureCode, message: string): never => {
  throw new ConvexError({ code, message });
};

/** Why the server stopped honoring a session it can still name the person for. */
export type SessionEnd = "suspended" | "removed";

/**
 * Fails `unauthenticated`, like any refused session, and says why beside the code, so a client
 * can tell someone their account was suspended or removed instead of only signing them out.
 */
export const failEnded = (reason: SessionEnd, message: string): never => {
  throw new ConvexError({ code: "unauthenticated", message, reason });
};
