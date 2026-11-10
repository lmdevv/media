import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { releaseTrickplayJob } from "../../movies/trickplayState";
import type { JobKind } from "./kinds";
import { ITEM_BATCH_MAX } from "./machine";
import { deleteFinishedJob } from "./store";

/** How long a finished job stays before the sweep deletes it. */
const FINISHED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** Most jobs one sweep call deletes. */
const SWEEP_JOBS_MAX = 256;

/** Most of their items one sweep call deletes; a job with more goes on in the next call. */
const SWEEP_ITEMS_MAX = ITEM_BATCH_MAX;

/**
 * The kinds whose finished jobs nothing needs (ADR 0012, "Finished jobs"). Scans stay, because a
 * library's `lastScan` is its scan state, and so does `probe.import`, which an `imports` row
 * names. A trickplay job that a file still waits on is released from the file first.
 */
const SWEPT_KINDS = [
  "movies.trickplay",
  "movies.metadata",
  "movies.person",
  "server.backup",
  "probe.capped",
  "probe.wide",
  "probe.items",
] as const satisfies ReadonlyArray<JobKind>;

const FINISHED = ["succeeded", "failed", "canceled"] as const;

const LANES = SWEPT_KINDS.flatMap((kind) => FINISHED.map((status) => ({ kind, status })));

type Lane = (typeof LANES)[number];

const oldJobs = (
  ctx: Pick<MutationCtx, "db">,
  lane: Lane,
  before: number,
  limit: number,
): Promise<ReadonlyArray<Doc<"jobs">>> =>
  ctx.db
    .query("jobs")
    .withIndex("by_kind_status_finished", (q) =>
      q.eq("payload.kind", lane.kind).eq("status", lane.status).lt("finishedAt", before),
    )
    .take(limit);

const collect = async (
  ctx: Pick<MutationCtx, "db">,
  lanes: ReadonlyArray<Lane>,
  before: number,
  found: ReadonlyArray<Doc<"jobs">> = [],
): Promise<ReadonlyArray<Doc<"jobs">>> => {
  const [lane, ...rest] = lanes;
  const room = SWEEP_JOBS_MAX - found.length;

  if (lane === undefined || room === 0) return found;

  return collect(ctx, rest, before, [...found, ...(await oldJobs(ctx, lane, before, room))]);
};

interface Swept {
  readonly jobs: number;
  readonly items: number;
  /** Whether a budget ran out, so more may be left. */
  readonly full: boolean;
}

const sweepJobs = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  jobs: ReadonlyArray<Doc<"jobs">>,
  swept: Swept = { jobs: 0, items: 0, full: false },
): Promise<Swept> => {
  const [job, ...rest] = jobs;

  if (job === undefined) return swept;

  const budget = SWEEP_ITEMS_MAX - swept.items;
  const deletion = await deleteFinishedJob(ctx, job, budget);

  const { payload } = job;

  if (deletion.deleted && payload.kind === "movies.trickplay") {
    await releaseTrickplayJob(ctx, { _id: job._id, status: job.status, payload });
  }

  const items = swept.items + deletion.items;

  return deletion.deleted
    ? sweepJobs(ctx, rest, { jobs: swept.jobs + 1, items, full: false })
    : { jobs: swept.jobs, items, full: true };
};

/**
 * Deletes finished jobs of `SWEPT_KINDS` that finished more than 7 days ago, at most 256 jobs and
 * 4,000 of their items per call, each job's items before the job. It schedules itself again at
 * once while a budget ran out. The hourly cron starts it; deleted jobs leave the index it reads, so
 * it needs no cursor, and two runs at once conflict and run one after the other.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.object({ jobs: v.number(), items: v.number(), more: v.boolean() }),
  handler: async (ctx) => {
    const old = await collect(ctx, LANES, Date.now() - FINISHED_KEPT_MS);
    const swept = await sweepJobs(ctx, old);
    const more = swept.full || old.length === SWEEP_JOBS_MAX;

    if (more) await ctx.scheduler.runAfter(0, internal.core.jobs.cleanup.sweep, {});

    return { jobs: swept.jobs, items: swept.items, more };
  },
});
