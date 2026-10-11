import { v } from "convex/values";

import { query } from "./_generated/server";

/** First-run state for the welcome screen. Public: it reveals only whether setup is done. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db.query("users").first();
    const library = await ctx.db.query("libraries").first();

    return { hasUsers: user !== null, hasLibraries: library !== null };
  },
});

/**
 * What the accept-invite screen shows for a code. Public, because the visitor is not signed in
 * yet; it reveals details only to someone who already holds the secret code.
 */
export const invite = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const found = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    if (found === null || found.revoked) return { state: "invalid" as const };
    const inviter = await ctx.db.get(found.createdBy);

    const details = {
      email: found.email ?? null,
      inviterName: inviter?.name ?? inviter?.email ?? null,
      createdAt: found._creationTime,
      expiresAt: found.expiresAt,
    };

    if (found.acceptedBy !== undefined) return { state: "used" as const, ...details };

    if (found.expiresAt < Date.now()) return { state: "expired" as const, ...details };

    return { state: "open" as const, ...details };
  },
});
