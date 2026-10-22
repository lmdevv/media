/**
 * Whether an invite or reset link can still be used. The server's lookup says `open` as of its
 * last change, so a link that expired while the screen was open still reads `open`; the clock
 * decides that.
 */

/** What a link allows: `open` shows the form, the others explain why not. */
export type LinkState = "open" | "expired" | "used" | "invalid";

/** The lookup fields this reads, as `inviteLookup` and `passwordResetLookup` return them. */
type LinkLookup =
  | { readonly state: "invalid" }
  | { readonly state: "open" | "expired" | "used"; readonly expiresAt: number };

/** The link's state at `now`, in milliseconds since the epoch. */
export const linkState = (lookup: LinkLookup, now: number): LinkState =>
  lookup.state === "open" && lookup.expiresAt <= now ? "expired" : lookup.state;
