import { can, forbiddenMessage } from "@music/commands/permissions";
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { fail } from "./lib/errors";
import { endSession, isStale, keyLapsed, openSession } from "./lib/sessions";
import { roleOf, SUSPENDED_MESSAGE } from "./lib/viewer";

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
    const user = await ctx.db.get(key.userId);

    if (user === null || keyLapsed(key, user)) return null;

    if (user.suspendedAt !== undefined) return fail("forbidden", SUSPENDED_MESSAGE);

    if (!can(roleOf(user), "keys")) return fail("forbidden", forbiddenMessage("keys"));

    const now = Date.now();
    const current = key.sessionId === undefined ? null : await ctx.db.get(key.sessionId);

    if (current !== null && current.expirationTime > now && !isStale(current, user)) {
      await ctx.db.patch(key._id, { lastUsedAt: now });

      return { userId: key.userId, sessionId: current._id };
    }

    if (current !== null) await endSession(ctx, current._id);

    const sessionId = await openSession(ctx, user);

    await ctx.db.patch(key._id, { lastUsedAt: now, sessionId });

    return { userId: key.userId, sessionId };
  },
});
