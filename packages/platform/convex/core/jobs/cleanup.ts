import { getDocumentSize, v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { DOCUMENT_BYTES } from "../../movies/fit";
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
 * Most bytes of jobs one sweep call reads, with the trickplay files it releases. Convex allows 16
 * MiB; the rest holds the items it deletes, at most 4,256 rows of a number each, read twice.
 */
const SWEEP_BYTES_MAX = 12 * 1024 * 1024;

/** Convex reads a document again to delete or rewrite it, so its bytes count twice. */
const READS_PER_DELETE = 2;

/**
 * What one job may cost before it is read: a Convex document is at most 1 MiB, and a job written
 * before its message and error were bounded may be that large.
 */
const JOB_BYTES_MAX = 1024 * 1024;

/**
 * The kinds whose finished jobs nothing needs (ADR 0012, "Finished jobs"). Scans stay, because a
 * library's `lastScan` is its scan state, and so do imports, which an `imports` row names. A
 * trickplay job that a file still waits on is released from the file first.
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

/** What deleting a job of the kind reads besides the job: a trickplay job's file, rewritten. */
const releaseBytes = (kind: JobKind): number =>
  kind === "movies.trickplay" ? READS_PER_DELETE * DOCUMENT_BYTES.mediaFiles : 0;

interface Swept {
  readonly jobs: number;
  readonly items: number;
  /** Bytes read so far: each job as stored, and what deleting it read. */
  readonly bytes: number;
  /** Whether a budget ran out, so more may be left. */
  readonly full: boolean;
}

const sweepJobs = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  jobs: ReadonlyArray<Doc<"jobs">>,
  swept: Swept,
): Promise<Swept> => {
  const [job, ...rest] = jobs;

  if (job === undefined) return swept;

  const budget = SWEEP_ITEMS_MAX - swept.items;
  const deletion = await deleteFinishedJob(ctx, job, budget);

  const { payload } = job;

  if (deletion.deleted && payload.kind === "movies.trickplay") {
    await releaseTrickplayJob(ctx, { _id: job._id, status: job.status, payload });
  }

  const next = {
    jobs: swept.jobs + (deletion.deleted ? 1 : 0),
    items: swept.items + deletion.items,
    bytes: swept.bytes + READS_PER_DELETE * getDocumentSize(job) + releaseBytes(payload.kind),
    full: !deletion.deleted,
  };

  return next.full ? next : sweepJobs(ctx, rest, next);
};

/**
 * Deletes old jobs of one lane while the budgets last. Each read takes only as many jobs as the
 * byte budget holds at 1 MiB each, read twice, so a call never reads past it, and the jobs it
 * reads are deleted before the next read.
 */
const sweepLane = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  lane: Lane,
  before: number,
  swept: Swept,
): Promise<Swept> => {
  const room = Math.min(
    SWEEP_JOBS_MAX - swept.jobs,
    Math.floor(
      (SWEEP_BYTES_MAX - swept.bytes) /
        (READS_PER_DELETE * JOB_BYTES_MAX + releaseBytes(lane.kind)),
    ),
  );

  if (room <= 0) return { ...swept, full: true };

  const jobs = await oldJobs(ctx, lane, before, room);
  const next = await sweepJobs(ctx, jobs, swept);

  return next.full || jobs.length < room ? next : sweepLane(ctx, lane, before, next);
};

const sweepLanes = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  lanes: ReadonlyArray<Lane>,
  before: number,
  swept: Swept,
): Promise<Swept> => {
  const [lane, ...rest] = lanes;

  if (lane === undefined) return swept;

  const next = await sweepLane(ctx, lane, before, swept);

  return next.full ? next : sweepLanes(ctx, rest, before, next);
};

/**
 * Deletes finished jobs of `SWEPT_KINDS` that finished more than 7 days ago, at most 256 jobs, 4,000
 * of their items, and 12 MiB of reads per call, each job's items before the job. It schedules
 * itself again at once while a budget ran out. The hourly cron starts it; deleted jobs leave the
 * index it reads, so it needs no cursor, and two runs at once conflict and run one after the other.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.object({ jobs: v.number(), items: v.number(), more: v.boolean() }),
  handler: async (ctx) => {
    const swept = await sweepLanes(ctx, LANES, Date.now() - FINISHED_KEPT_MS, {
      jobs: 0,
      items: 0,
      bytes: 0,
      full: false,
    });

    if (swept.full) await ctx.scheduler.runAfter(0, internal.core.jobs.cleanup.sweep, {});

    return { jobs: swept.jobs, items: swept.items, more: swept.full };
  },
});
