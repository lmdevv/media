/**
 * The stored job, one union over its status, so a queued job cannot carry a lease and a finished
 * job cannot carry a worker. `store.ts` writes each state whole with `db.replace`, so a
 * transition never leaves a field of the state it left. `schema.ts` imports this module, so it
 * imports only `convex/values` and `kinds.ts`.
 */
import { v } from "convex/values";
import type { Infer, ObjectType } from "convex/values";

import { jobItem, jobPayload } from "./kinds";

/**
 * How far a job got, in the mode its kind picks. `reported`: the worker reports done and total.
 * `items`: done is the watermark below which every batched item is complete, `appended` counts the
 * items the holders appended, and `sealed` says no more will come.
 */
export const jobWork = v.union(
  v.object({
    mode: v.literal("reported"),
    done: v.number(),
    total: v.union(v.number(), v.null()),
  }),
  v.object({
    mode: v.literal("items"),
    done: v.number(),
    appended: v.number(),
    sealed: v.boolean(),
  }),
);

export type JobWork = Infer<typeof jobWork>;

const common = {
  payload: jobPayload,
  /** From the kind's `dedupe` at enqueue; null when the kind does not dedupe. */
  dedupeKey: v.union(v.string(), v.null()),
  /**
   * Claims so far. The claim that makes attempt N hands its worker the lease `{ jobId, attempt: N }`,
   * so attempts is also the fencing token.
   */
  attempts: v.number(),
  /** Counted against the kind's `maxStrikes`. */
  strikes: v.number(),
  work: jobWork,
  /** The holder's last status line, kept across attempts. */
  message: v.union(v.string(), v.null()),
};

export type JobCommon = ObjectType<typeof common>;

export const jobDocument = v.union(
  v.object({
    ...common,
    status: v.literal("queued"),
    /** Why the last attempt ended, while the job waits for its next. */
    lastError: v.union(v.string(), v.null()),
  }),
  v.object({
    ...common,
    status: v.literal("running"),
    /** Who holds the lease, for people reading the job; fencing uses `attempts`. */
    workerId: v.string(),
    leaseExpiresAt: v.number(),
    claimedAt: v.number(),
    /** Whether this attempt made durable progress: moved the item watermark, appended, or raised done. */
    progressed: v.boolean(),
    /**
     * Set by cancel. The job keeps its slot until its worker's next lease call or the lease
     * lapses, so the cap still counts the process that may be running; then it becomes canceled.
     */
    cancelRequestedAt: v.union(v.number(), v.null()),
  }),
  v.object({ ...common, status: v.literal("succeeded"), finishedAt: v.number() }),
  v.object({ ...common, status: v.literal("failed"), finishedAt: v.number(), error: v.string() }),
  v.object({ ...common, status: v.literal("canceled"), finishedAt: v.number() }),
);

export type JobFields = Infer<typeof jobDocument>;

export type JobStatus = JobFields["status"];

export const jobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

/** One batched item. `seq` counts from 0 per job in append order. */
export const jobItemDocument = v.object({
  jobId: v.id("jobs"),
  seq: v.number(),
  item: jobItem,
});

/** What a worker holds: the job and the attempt it claimed. */
export const lease = v.object({ jobId: v.id("jobs"), attempt: v.number() });

export type Lease = Infer<typeof lease>;
