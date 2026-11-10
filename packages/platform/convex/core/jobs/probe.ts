import { v } from "convex/values";

import { internalMutation, internalQuery } from "../../_generated/server";
import { inOrder } from "../lib/inOrder";
import { kindDef } from "./kinds";
import { cancel, enqueue as enqueueJob } from "./queue";

const probeRunKind = v.union(
  v.literal("probe.capped"),
  v.literal("probe.wide"),
  v.literal("probe.items"),
);

const probeKind = v.union(probeRunKind, v.literal("probe.import"));

const PROBE_BATCH = 1000;

/**
 * Queues `count` probe jobs `{ run, n }` of one kind, n from 0.
 *
 * @throws Error when `count` is not a whole number from 1 to 1,000.
 */
export const enqueue = internalMutation({
  args: { kind: probeRunKind, run: v.string(), count: v.number() },
  returns: v.array(v.id("jobs")),
  handler: async (ctx, { kind, run, count }) => {
    if (!Number.isSafeInteger(count) || count < 1 || count > PROBE_BATCH) {
      throw new Error(`probe enqueue queues 1 to ${PROBE_BATCH} jobs; got ${count}`);
    }

    const queued = await inOrder(
      Array.from({ length: count }, (_, n) => n),
      (n) => enqueueJob(ctx, { kind, run, n }),
    );

    return queued.map((job) => job.jobId);
  },
});

/**
 * Cancels up to 1,000 queued jobs of a probe kind and requests the cancel of its running ones, so
 * a lane starts from an empty queue whatever an aborted run left. A running job frees its slot at
 * its lease's lapse. Says whether queued jobs remain; the caller loops.
 */
export const reset = internalMutation({
  args: { kind: probeKind },
  returns: v.object({ more: v.boolean() }),
  handler: async (ctx, { kind }) => {
    const jobs = (status: "queued" | "running", limit: number) =>
      ctx.db
        .query("jobs")
        .withIndex("by_kind_status", (q) => q.eq("payload.kind", kind).eq("status", status))
        .take(limit);

    const queued = await jobs("queued", PROBE_BATCH);
    const running = await jobs("running", kindDef(kind).cap);

    await inOrder([...queued, ...running], (job) => cancel(ctx, job._id));

    return { more: queued.length === PROBE_BATCH };
  },
});

export const hasItems = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.boolean(),
  handler: async (ctx, { jobId }) =>
    (await ctx.db
      .query("jobItems")
      .withIndex("by_job_seq", (q) => q.eq("jobId", jobId))
      .first()) !== null,
});

/**
 * Moves a finished job's end back in time, so a test can make a job old enough for the sweep of
 * finished jobs without waiting a week.
 *
 * @throws Error when the job is gone, queued, or running.
 */
export const backdate = internalMutation({
  args: { jobId: v.id("jobs"), finishedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { jobId, finishedAt }) => {
    const job = await ctx.db.get("jobs", jobId);

    if (job === null || job.status === "queued" || job.status === "running") {
      throw new Error(`Only a finished job is backdated; ${jobId} is ${job?.status ?? "gone"}`);
    }

    await ctx.db.patch("jobs", jobId, { finishedAt });

    return null;
  },
});
