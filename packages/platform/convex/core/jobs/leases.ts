import { v } from "convex/values";

import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";
import { inOrder } from "../lib/inOrder";
import { jobKind } from "./kinds";
import { applyEvent, deleteItemBatch, endPause as endKindPause } from "./store";

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

    await inOrder(lapsed, (job) => applyEvent(ctx, job, { type: "lapse" }));

    const more = lapsed.length === RELEASE_BATCH;

    if (more) await ctx.scheduler.runAfter(0, internal.core.jobs.leases.releaseExpired, {});

    return { released: lapsed.length, more };
  },
});

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

/** Makes a job that waited for a retry's time claimable, when it still waits for that attempt. */
export const wake = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { jobId, attempt }) => {
    const job = await ctx.db.get("jobs", jobId);

    if (job !== null) await applyEvent(ctx, job, { type: "wake", attempt });

    return null;
  },
});

/** Ends a kind's pause once its time came (scheduled by the pause itself). */
export const endPause = internalMutation({
  args: { kind: jobKind },
  returns: v.null(),
  handler: async (ctx, { kind }) => {
    await endKindPause(ctx, kind, Date.now());

    return null;
  },
});

const WAKE_BATCH = 200;

/**
 * Wakes waiting retries and ends pauses whose time passed without their scheduled call, as after a
 * restore from a backup, which keeps the rows but not the schedule. It reads only rows whose time
 * passed, through `by_status_wait` and `by_paused`, so a quiet minute reads nothing.
 */
export const wakeDue = internalMutation({
  args: {},
  returns: v.object({ woken: v.number(), resumed: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();

    const [due, paused] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_status_wait", (q) =>
          q.eq("status", "queued").gte("waitUntil", 0).lte("waitUntil", now),
        )
        .take(WAKE_BATCH),
      ctx.db
        .query("jobKinds")
        .withIndex("by_paused", (q) => q.gte("pausedUntil", 0).lte("pausedUntil", now))
        .collect(),
    ]);

    await inOrder(due, (job) => applyEvent(ctx, job, { type: "wake", attempt: null }));
    await inOrder(paused, (row) => endKindPause(ctx, row.kind, now));

    if (due.length === WAKE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.core.jobs.leases.wakeDue, {});
    }

    return { woken: due.length, resumed: paused.length };
  },
});
