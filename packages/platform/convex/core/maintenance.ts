import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { applyEvent } from "./jobs/store";
import { inOrder } from "./lib/inOrder";
import { paginate } from "./lib/paginate";
import { dropSession } from "./sessions";

/**
 * Running jobs one call settles. A kind's cap bounds its running jobs, so a snapshot holds at most
 * the caps added up, 27 today. A row a worker wrote before job text was bounded may approach
 * Convex's 1 MiB, read twice to rewrite it, so 4 a call stays inside the 16 MiB a call may read.
 */
const JOBS_PER_CALL = 4;

/**
 * Sessions one call ends. Each costs a read, a delete, and a scheduled deletion of its refresh
 * tokens (`dropSession`), so a session that gathered thousands of them costs this call nothing more.
 */
const SESSIONS_PER_CALL = 100;

const RESTORED_BACKUP = "Restored from this backup";

const restoredEnd = (job: Doc<"jobs">) =>
  job.payload.kind === "server.backup"
    ? ({ outcome: "succeed", message: RESTORED_BACKUP } as const)
    : ({ outcome: "requeue" } as const);

const settlePage = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  before: number,
  cursor: string | null,
): Promise<number> => {
  const page = await paginate(
    ctx.db,
    { table: "jobs", index: "by_status", range: (q) => q.eq("status", "running") },
    { numItems: JOBS_PER_CALL, cursor },
  );

  const caught = page.page.filter((job) => job.status === "running" && job.claimedAt < before);

  await inOrder(caught, (job) => applyEvent(ctx, job, { type: "restored", end: restoredEnd(job) }));

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.core.maintenance.settleRestoredJobsFrom, {
      before,
      cursor: page.continueCursor,
    });
  }

  return caught.length;
};

const endPage = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  before: number,
  cursor: string | null,
): Promise<number> => {
  const page = await paginate(
    ctx.db,
    {
      table: "authSessions",
      index: "by_creation_time",
      range: (q) => q.lt("_creationTime", before),
    },
    { numItems: SESSIONS_PER_CALL, cursor },
  );

  await Promise.all(page.page.map((session) => dropSession(ctx, session._id)));

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.core.maintenance.endSessionsFrom, {
      before,
      cursor: page.continueCursor,
    });
  }

  return page.page.length;
};

const pageArgs = { before: v.number(), cursor: v.string() };

/**
 * Settles the jobs a restored snapshot caught mid-run, for the restore procedure, right after
 * `convex import` and before `endAllSessions` (ADR 0010): `convex run
 * core/maintenance:settleRestoredJobs '{}'` with the core's admin key. The snapshot was taken while
 * its own backup job ran, and other jobs may have been running too. A running `server.backup` job
 * succeeds, since the archive being restored is its result; every other running job goes back to
 * the queue at once with no strike, instead of waiting for its lease to lapse, since the worker
 * that held it moved on. Queued jobs stay. Answers how many jobs the first page settled; later
 * pages run as scheduled calls.
 */
export const settleRestoredJobs = internalMutation({
  args: {},
  returns: v.object({ settled: v.number() }),
  handler: async (ctx) => ({ settled: await settlePage(ctx, Date.now(), null) }),
});

/** A later page of `settleRestoredJobs`. */
export const settleRestoredJobsFrom = internalMutation({
  args: pageArgs,
  returns: v.null(),
  handler: async (ctx, { before, cursor }) => {
    await settlePage(ctx, before, cursor);

    return null;
  },
});

/**
 * Ends every session, for the restore procedure, after `settleRestoredJobs`: `convex run
 * core/maintenance:endAllSessions '{}'` with the core's admin key. A restored snapshot carries the
 * sessions and refresh tokens it was taken with, ones signed out since included, and they keep
 * working until ended, so everyone signs in again. API keys and device grants stay: the media
 * server signs in again with its key, and an app exchanges its device's grant again. Answers how
 * many sessions the first page ended; later pages run as scheduled calls.
 */
export const endAllSessions = internalMutation({
  args: {},
  returns: v.object({ ended: v.number() }),
  handler: async (ctx) => ({ ended: await endPage(ctx, Date.now(), null) }),
});

/** A later page of `endAllSessions`. */
export const endSessionsFrom = internalMutation({
  args: pageArgs,
  returns: v.null(),
  handler: async (ctx, { before, cursor }) => {
    await endPage(ctx, before, cursor);

    return null;
  },
});
