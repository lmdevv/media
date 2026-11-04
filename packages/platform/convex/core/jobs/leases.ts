/**
 * The framework's own background work: the one lease-release cron target for every kind, and the
 * batched purge of a finished job's leftover items. Both stay inside the per-call limits.
 */
import { v } from "convex/values";

import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";
import { applyEvent, deleteItemBatch } from "./store";

/** Lapsed leases one call releases; each writes its job and may schedule one purge. */
const RELEASE_BATCH = 200;

/**
 * Releases running jobs whose lease expired, oldest expiry first, through `by_status_lease`. Each
 * release is the machine's lapse. A full batch schedules the next one at once, so a burst larger
 * than one batch drains without waiting for the cron. Two chains read the same range and
 * conflict, Convex serializes them, and the later one sees only rows still lapsed, so a job is
 * never released twice.
 */
export const releaseExpired = internalMutation({
  args: {},
  returns: v.object({ released: v.number(), more: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();

    const lapsed = await ctx.db
      .query("jobs")
      .withIndex("by_status_lease", (q) => q.eq("status", "running").lt("leaseExpiresAt", now))
      .take(RELEASE_BATCH);

    await Promise.all(lapsed.map((job) => applyEvent(ctx, job, { type: "lapse" })));

    const more = lapsed.length === RELEASE_BATCH;

    if (more) await ctx.scheduler.runAfter(0, internal.core.jobs.leases.releaseExpired, {});

    return { released: lapsed.length, more };
  },
});

/**
 * Deletes a finished job's items from `from` up, 4,000 per call, rescheduling itself until none
 * are left. The finishing transition schedules it in its own mutation.
 */
export const purgeItems = internalMutation({
  args: { jobId: v.id("jobs"), from: v.number() },
  returns: v.null(),
  handler: async (ctx, { jobId, from }) => {
    const next = await deleteItemBatch(ctx, jobId, from);

    if (next !== null) {
      await ctx.scheduler.runAfter(0, internal.core.jobs.leases.purgeItems, {
        jobId,
        from: next.next,
      });
    }

    return null;
  },
});
