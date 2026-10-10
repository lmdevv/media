import { ConvexError } from "convex/values";

/** Expected failures a caller can act on. Clients read `data.code` and show `data.message`. */
export type FailureCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_args"
  | "conflict"
  | "signup_closed"
  | "internal";

/** Throws a `ConvexError`, Convex's transport for expected failures. */
export const fail = (code: FailureCode, message: string): never => {
  throw new ConvexError({ code, message });
};
