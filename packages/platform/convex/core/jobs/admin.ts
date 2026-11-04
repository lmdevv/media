import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import type { Doc } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { internalMutation, internalQuery } from "../../_generated/server";
import { paginate } from "../lib/paginate";
import { jobKind, jobPayload } from "./kinds";
import type { JobKind } from "./kinds";
import { progressOf } from "./machine";
import { jobStatus } from "./model";
import type { JobStatus } from "./model";
import { cancel as cancelJob } from "./queue";

const jobView = v.object({
  id: v.id("jobs"),
  createdAt: v.number(),
  status: jobStatus,
  payload: jobPayload,
  attempts: v.number(),
  strikes: v.number(),
  done: v.number(),
  total: v.union(v.number(), v.null()),
  message: v.union(v.string(), v.null()),
  error: v.union(v.string(), v.null()),
  /** True while a cancel waits for the running worker to stop. */
  canceling: v.boolean(),
  finishedAt: v.union(v.number(), v.null()),
});

type JobView = Infer<typeof jobView>;

const errorOf = (job: Doc<"jobs">): string | null => {
  if (job.status === "queued") return job.lastError;

  return job.status === "failed" ? job.error : null;
};

const viewOf = (job: Doc<"jobs">): JobView => ({
  id: job._id,
  createdAt: job._creationTime,
  status: job.status,
  payload: job.payload,
  attempts: job.attempts,
  strikes: job.strikes,
  ...progressOf(job.work),
  message: job.message,
  error: errorOf(job),
  canceling: job.status === "running" && job.cancelRequestedAt !== null,
  finishedAt: job.status === "queued" || job.status === "running" ? null : job.finishedAt,
});

const pageOf = (
  db: DatabaseReader,
  kind: JobKind | undefined,
  status: JobStatus | undefined,
  options: Infer<typeof paginationOptsValidator>,
): Promise<PaginationResult<Doc<"jobs">>> => {
  if (kind !== undefined && status !== undefined) {
    return paginate(
      db,
      {
        table: "jobs",
        index: "by_kind_status",
        range: (q) => q.eq("payload.kind", kind).eq("status", status),
        order: "desc",
      },
      options,
    );
  }

  if (kind !== undefined) {
    return paginate(
      db,
      { table: "jobs", index: "by_kind", range: (q) => q.eq("payload.kind", kind), order: "desc" },
      options,
    );
  }

  if (status !== undefined) {
    return paginate(
      db,
      {
        table: "jobs",
        index: "by_status",
        range: (q) => q.eq("status", status),
        order: "desc",
      },
      options,
    );
  }

  return paginate(db, { table: "jobs", index: "by_creation_time", order: "desc" }, options);
};

export const list = internalQuery({
  args: {
    kind: v.optional(jobKind),
    status: v.optional(jobStatus),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(jobView),
  handler: async (ctx, { kind, status, paginationOpts }) => {
    const result = await pageOf(ctx.db, kind, status, paginationOpts);

    return { ...result, page: result.page.map(viewOf) };
  },
});

export const get = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.union(jobView, v.null()),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get("jobs", jobId);

    return job === null ? null : viewOf(job);
  },
});

export const cancel = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.union(
    v.object({
      outcome: v.literal("finished"),
      status: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("canceled")),
    }),
    v.object({ outcome: v.literal("canceling") }),
    v.object({ outcome: v.literal("notFound") }),
  ),
  handler: (ctx, { jobId }) => cancelJob(ctx, jobId),
});
