/**
 * Limits on how often something may happen, kept in Convex Auth's `authRateLimits` table with
 * its algorithm: each identifier has a bucket of `perHour` attempts that refills steadily. Convex
 * Auth keys its sign-in limits by account (an email address); the identifiers here are prefixed
 * and never contain `@`, so the two never share a bucket.
 */
import type { MutationCtx } from "../_generated/server";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Takes one attempt from `identifier`'s bucket of `perHour`, and returns whether there was one.
 * The caller's mutation rolls the attempt back if it fails afterwards, so only what went through
 * counts against the limit.
 */
export const takeAttempt = async (
  ctx: MutationCtx,
  identifier: string,
  perHour: number,
): Promise<boolean> => {
  const now = Date.now();

  const row = await ctx.db
    .query("authRateLimits")
    .withIndex("identifier", (q) => q.eq("identifier", identifier))
    .unique();

  const available =
    row === null
      ? perHour
      : Math.min(perHour, row.attemptsLeft + ((now - row.lastAttemptTime) * perHour) / HOUR_MS);

  if (available < 1) return false;

  const next = { attemptsLeft: available - 1, lastAttemptTime: now };

  if (row === null) await ctx.db.insert("authRateLimits", { identifier, ...next });
  else await ctx.db.patch(row._id, next);

  return true;
};
