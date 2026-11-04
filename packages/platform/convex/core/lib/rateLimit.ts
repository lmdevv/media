import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

const HOUR_MS = 60 * 60 * 1000;

/** A token bucket in `rateLimits`: `perHour` attempts per identifier, refilling continuously. */
export interface RateLimit {
  readonly identifier: string;
  readonly perHour: number;
}

type Ctx = Pick<MutationCtx, "db">;

const rowOf = (ctx: Ctx, limit: RateLimit) =>
  ctx.db
    .query("rateLimits")
    .withIndex("by_identifier", (q) => q.eq("identifier", limit.identifier))
    .unique();

const bucket = async (ctx: Ctx, limit: RateLimit, now: number) => {
  const row = await rowOf(ctx, limit);

  const available =
    row === null
      ? limit.perHour
      : Math.min(
          limit.perHour,
          row.attemptsLeft + ((now - row.lastAttemptTime) * limit.perHour) / HOUR_MS,
        );

  return { row, available };
};

const store = async (
  ctx: Ctx,
  limit: RateLimit,
  row: Doc<"rateLimits"> | null,
  attemptsLeft: number,
  now: number,
): Promise<void> => {
  const next = { attemptsLeft, lastAttemptTime: now };

  if (row === null) await ctx.db.insert("rateLimits", { identifier: limit.identifier, ...next });
  else await ctx.db.patch(row._id, next);
};

/** Takes one attempt from the bucket, and returns whether there was one to take. */
export const takeAttempt = async (ctx: Ctx, limit: RateLimit, now: number): Promise<boolean> => {
  const { row, available } = await bucket(ctx, limit, now);

  if (available < 1) return false;

  await store(ctx, limit, row, available - 1, now);

  return true;
};

/** Gives back the attempt a call took, for an attempt that succeeded. */
export const refundAttempt = async (ctx: Ctx, limit: RateLimit, now: number): Promise<void> => {
  const { row, available } = await bucket(ctx, limit, now);

  await store(ctx, limit, row, Math.min(limit.perHour, available + 1), now);
};

export const clearAttempts = async (ctx: Ctx, limit: RateLimit): Promise<void> => {
  const row = await rowOf(ctx, limit);

  if (row !== null) await ctx.db.delete(row._id);
};
