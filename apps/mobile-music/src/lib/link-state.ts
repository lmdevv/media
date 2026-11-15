import { isFailure } from "@media/mobile-core/failure";

/** What a link allows: `open` shows the form, the others explain why not. */
export type LinkState = "loading" | "open" | "expired" | "invalid";

/**
 * The link's state at `now`, in milliseconds since the epoch, from the core's lookup: undefined
 * while it loads, its expiry once it answers, or its refusal. The core refuses a link that was
 * used or ran out as expired, and one it does not know as anything else.
 */
export const linkState = (
  lookup: { readonly expiresAt: number } | Error | undefined,
  now: number,
): LinkState => {
  if (lookup === undefined) return "loading";

  if (lookup instanceof Error) return isFailure(lookup, "Expired") ? "expired" : "invalid";

  return lookup.expiresAt <= now ? "expired" : "open";
};
