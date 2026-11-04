import { ConvexError } from "convex/values";

/** Why a call was refused, as clients see it in `ConvexError.data.code`. */
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "rate_limited"
  | "invalid_args"
  | "not_found"
  | "conflict"
  | "expired"
  | "pending"
  | "denied";

/** Refuses the call: throws a `ConvexError` with `{ code, message }` for the client. */
export const fail = (code: ErrorCode, message: string): never => {
  throw new ConvexError({ code, message });
};
