import { ConvexError } from "convex/values";

/** Expected failure codes; `ErrorCode` in `@media/contracts/errors` lists the same values. */
export type FailureCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_args"
  | "conflict"
  | "expired"
  | "stale_revision"
  | "rate_limited"
  | "internal";

/**
 * Fails the current function with an expected failure. Convex rolls back the transaction and the
 * client receives `{ code, message }` as the `ConvexError` data.
 *
 * @throws ConvexError always; Convex's transport for expected failures.
 */
export const fail = (code: FailureCode, message: string): never => {
  throw new ConvexError({ code, message });
};
