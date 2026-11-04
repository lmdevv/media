import { v } from "convex/values";

import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";
import { sweepExpiredSessions } from "../sessions";

const SWEEP_BATCH = 500;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Deletes sign-in rows nothing can use anymore, a batch of each at a time, and runs again while a
 * batch comes back full: expired refresh tokens and sessions, device codes an hour past their
 * expiry, and rate limit buckets idle long enough to be full again.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    const [refreshTokens, deviceCodes, rateLimits] = await Promise.all([
      ctx.db
        .query("authRefreshTokens")
        .withIndex("by_expiration", (q) => q.lt("expirationTime", now))
        .take(SWEEP_BATCH),
      ctx.db
        .query("deviceCodes")
        .withIndex("by_expiration", (q) => q.lt("expiresAt", now - HOUR_MS))
        .take(SWEEP_BATCH),
      ctx.db
        .query("rateLimits")
        .withIndex("by_last_attempt", (q) => q.lt("lastAttemptTime", now - HOUR_MS))
        .take(SWEEP_BATCH),
    ]);

    const swept = [...refreshTokens, ...deviceCodes, ...rateLimits];

    await Promise.all(swept.map((row) => ctx.db.delete(row._id)));

    const sessions = await sweepExpiredSessions(ctx, now, SWEEP_BATCH);

    if (
      sessions === SWEEP_BATCH ||
      [refreshTokens, deviceCodes, rateLimits].some((rows) => rows.length === SWEEP_BATCH)
    ) {
      await ctx.scheduler.runAfter(0, internal.core.auth.sweep.sweep, {});
    }

    return null;
  },
});
