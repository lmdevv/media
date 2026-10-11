import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { endSession } from "./lib/sessions";

/** Matches Convex Auth's default session lifetime, which `auth.ts` does not change. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Looks up an API key by hash for the `apikey` sign-in provider, records its use, and returns the
 * session the sign-in joins. All sign-ins with one key share a session, so revoking the key can
 * end every token it ever issued by deleting that session.
 */
export const redeem = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();

    if (key === null || key.revokedAt !== undefined) return null;
    const now = Date.now();
    const current = key.sessionId === undefined ? null : await ctx.db.get(key.sessionId);

    if (current !== null && current.expirationTime > now) {
      await ctx.db.patch(key._id, { lastUsedAt: now });

      return { userId: key.userId, sessionId: current._id };
    }

    if (current !== null) await endSession(ctx, current._id);

    const sessionId = await ctx.db.insert("authSessions", {
      userId: key.userId,
      expirationTime: now + SESSION_MS,
    });

    await ctx.db.patch(key._id, { lastUsedAt: now, sessionId });

    return { userId: key.userId, sessionId };
  },
});
