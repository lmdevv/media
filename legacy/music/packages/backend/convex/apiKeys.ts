import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

/** Looks up an API key by hash for the `apikey` sign-in provider and records its use. */
export const redeem = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();

    if (key === null || key.revokedAt !== undefined) return null;
    await ctx.db.patch(key._id, { lastUsedAt: Date.now() });

    return key.userId;
  },
});
