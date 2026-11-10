import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { inOrder } from "../lib/inOrder";
import { kindDef } from "./kinds";
import type { JobKind, JobPayload } from "./kinds";
import { ITEM_BATCH_MAX, pickClaim, step } from "./machine";
import type { ItemWrite, JobEvent, KindQueue, Step } from "./machine";
import type { JobWork, Lease } from "./model";

/** What every job write needs: the database, and the scheduler for item purges. */
export type JobCtx = Pick<MutationCtx, "db" | "scheduler">;

export interface Enqueued {
  readonly jobId: Id<"jobs">;
  /** False when the kind's dedupe key matched a queued or running job, whose id this is. */
  readonly created: boolean;
}

const kindRow = (db: DatabaseReader, kind: JobKind): Promise<Doc<"jobKinds"> | null> =>
  db
    .query("jobKinds")
    .withIndex("by_kind", (q) => q.eq("kind", kind))
    .unique();

/**
 * Moves a kind's row by what one job transition did: `running` by the job entering or leaving
 * `running`, and `queueFrom` down to a job that becomes queued before it, or up to the job a claim
 * took, which was the oldest queued. Writes nothing when neither moves.
 */
const moveKindRow = async (
  ctx: JobCtx,
  kind: JobKind,
  move: {
    readonly running: number;
    readonly queued: number | null;
    readonly claimed: number | null;
  },
): Promise<void> => {
  if (move.running === 0 && move.queued === null && move.claimed === null) return;

  const row = await kindRow(ctx.db, kind);
  const running = (row?.running ?? 0) + move.running;
  const from = row?.queueFrom ?? 0;
  const lowered = move.queued === null ? from : Math.min(from, move.queued);
  const queueFrom = move.claimed === null ? lowered : Math.max(lowered, move.claimed);

  if (row === null) {
    await ctx.db.insert("jobKinds", { kind, running, queueFrom });
  } else if (running !== row.running || queueFrom !== row.queueFrom) {
    await ctx.db.patch("jobKinds", row._id, { running, queueFrom });
  }
};

const activeWithKey = async (db: DatabaseReader, dedupeKey: string): Promise<Doc<"jobs"> | null> =>
  (await db
    .query("jobs")
    .withIndex("by_dedupe_status", (q) => q.eq("dedupeKey", dedupeKey).eq("status", "queued"))
    .first()) ??
  db
    .query("jobs")
    .withIndex("by_dedupe_status", (q) => q.eq("dedupeKey", dedupeKey).eq("status", "running"))
    .first();

/**
 * Inserts a queued job, or returns the active job with the same dedupe key. Dedupe reads at most
 * two index entries, so two concurrent enqueues of one key conflict and Convex serializes them:
 * exactly one inserts.
 */
export const insertJob = async (ctx: JobCtx, payload: JobPayload): Promise<Enqueued> => {
  const def = kindDef(payload.kind);
  const dedupeKey = def.dedupeKey(payload);

  if (dedupeKey !== null) {
    const active = await activeWithKey(ctx.db, dedupeKey);

    if (active !== null) return { jobId: active._id, created: false };
  }

  const work: JobWork =
    def.item === null
      ? { mode: "reported", done: 0, total: null }
      : { mode: "items", done: 0, appended: 0, sealed: false };

  const jobId = await ctx.db.insert("jobs", {
    status: "queued",
    payload,
    dedupeKey,
    attempts: 0,
    strikes: 0,
    work,
    message: null,
    lastError: null,
  });

  const job = await ctx.db.get("jobs", jobId);

  if (job === null) throw new Error(`The job ${jobId} this enqueue inserted is gone`);

  const row = await kindRow(ctx.db, payload.kind);

  if (row !== null && job._creationTime < row.queueFrom) {
    await ctx.db.patch("jobKinds", row._id, { queueFrom: job._creationTime });
  }

  return { jobId, created: true };
};

const deleteItems = async (
  ctx: JobCtx,
  jobId: Id<"jobs">,
  from: number,
  to: number,
): Promise<void> => {
  const rows = await ctx.db
    .query("jobItems")
    .withIndex("by_job_seq", (q) => q.eq("jobId", jobId).gte("seq", from).lt("seq", to))
    .take(Math.min(to - from, ITEM_BATCH_MAX));

  await Promise.all(rows.map((row) => ctx.db.delete("jobItems", row._id)));
};

const applyWrite = async (ctx: JobCtx, jobId: Id<"jobs">, write: ItemWrite): Promise<void> => {
  switch (write.type) {
    case "drop":
      await deleteItems(ctx, jobId, write.from, write.to);

      return;

    case "insert":
      await Promise.all(
        write.items.map((item, offset) =>
          ctx.db.insert("jobItems", { jobId, seq: write.from + offset, item }),
        ),
      );

      return;

    case "purge":
      await ctx.scheduler.runAfter(0, internal.core.jobs.leases.purgeItems, {
        jobId,
        from: write.from,
      });
  }
};

/**
 * Runs one machine step on a stored job and applies it in this mutation: the next state with
 * `db.replace`, the kind's row, then its item writes. A step that changes nothing writes nothing.
 * Calls in one mutation must run one after another (`inOrder`), because each reads and writes
 * its kind's row.
 */
export const applyEvent = async (ctx: JobCtx, job: Doc<"jobs">, event: JobEvent): Promise<Step> => {
  const result = step(job, event, Date.now(), kindDef(job.payload.kind));

  if (!result.ok || !result.changed) return result;

  await ctx.db.replace("jobs", job._id, result.next);

  const { status } = result.next;
  const wasRunning = job.status === "running" ? 1 : 0;
  const isRunning = status === "running" ? 1 : 0;

  await moveKindRow(ctx, job.payload.kind, {
    running: isRunning - wasRunning,
    queued: status === "queued" && job.status !== "queued" ? job._creationTime : null,
    claimed: job.status === "queued" && status === "running" ? job._creationTime : null,
  });

  await inOrder(result.writes, (write) => applyWrite(ctx, job._id, write));

  if (wasRunning === 1 && isRunning === 0) await followUpScan(ctx, job.payload, status);

  return result;
};

/**
 * Queues one more scan of a library whose files changed while its scan ran, once that scan stops
 * running (`rescanAfter`, ADR 0024). A scan that goes back to the queue starts over, so it only
 * clears the mark. The enqueue's dedupe joins a scan someone else queued meanwhile.
 */
const followUpScan = async (
  ctx: JobCtx,
  payload: JobPayload,
  status: Doc<"jobs">["status"],
): Promise<void> => {
  if (payload.kind !== "movies.scan" && payload.kind !== "music.scan") return;

  const library = await ctx.db.get("libraries", payload.libraryId);

  if (library?.rescanAfter !== true) return;

  await ctx.db.patch(library._id, { rescanAfter: undefined });

  if (status === "queued") return;

  const scan = await insertJob(ctx, payload);

  if (scan.created) await ctx.db.patch(library._id, { lastScan: scan.jobId });
};

/**
 * What a claim of `kind` would see: the kind's running count and, when it is below the cap, its
 * oldest queued job. It reads the kind's row and one index entry, not the ranges a busy queue
 * leaves its old entries in. Every claim and every job leaving `running` writes that row, so
 * claims of one kind conflict with each other and with finishes, and Convex runs them one after
 * the other; the cap holds under any number of workers.
 */
export const kindQueue = async (
  db: DatabaseReader,
  kind: JobKind,
): Promise<KindQueue<Id<"jobs">>> => {
  const { cap } = kindDef(kind);
  const row = await kindRow(db, kind);
  const running = row?.running ?? 0;

  if (running >= cap) return { cap, running, head: null };

  const head = await db
    .query("jobs")
    .withIndex("by_kind_status", (q) =>
      q
        .eq("payload.kind", kind)
        .eq("status", "queued")
        .gte("_creationTime", row?.queueFrom ?? 0),
    )
    .first();

  return {
    cap,
    running,
    head: head === null ? null : { jobId: head._id, createdAt: head._creationTime },
  };
};

export type ClaimAnswer =
  | {
      readonly outcome: "claimed";
      readonly lease: Lease;
      readonly leaseExpiresAt: number;
      readonly payload: JobPayload;
      readonly work: JobWork;
    }
  | { readonly outcome: "idle" };

/**
 * Claims the oldest queued job among `kinds` whose kind has a free slot. A resumed item job's
 * `work` tells the new holder where to continue appending and processing.
 *
 * @throws Error when the machine refuses to claim the queued job this call just read, a defect.
 */
export const claimJob = async (
  ctx: JobCtx,
  kinds: ReadonlyArray<JobKind>,
  workerId: string,
  leaseMs: number,
): Promise<ClaimAnswer> => {
  const queues = await Promise.all([...new Set(kinds)].map((kind) => kindQueue(ctx.db, kind)));
  const jobId = pickClaim(queues);

  if (jobId === null) return { outcome: "idle" };

  const job = await ctx.db.get("jobs", jobId);

  if (job === null) throw new Error(`The queued job ${jobId} this claim read is gone`);

  const result = await applyEvent(ctx, job, { type: "claim", workerId, leaseMs });

  if (!result.ok || result.next.status !== "running") {
    throw new Error(`The queued job ${jobId} refused its claim`);
  }

  return {
    outcome: "claimed",
    lease: { jobId, attempt: result.next.attempts },
    leaseExpiresAt: result.next.leaseExpiresAt,
    payload: result.next.payload,
    work: result.next.work,
  };
};

/**
 * Deletes up to `ITEM_BATCH_MAX` of a finished job's items from `from` up, and says where the next
 * batch starts or that none are left.
 */
export const deleteItemBatch = async (
  ctx: JobCtx,
  jobId: Id<"jobs">,
  from: number,
): Promise<{ readonly next: number } | null> => {
  const rows = await ctx.db
    .query("jobItems")
    .withIndex("by_job_seq", (q) => q.eq("jobId", jobId).gte("seq", from))
    .take(ITEM_BATCH_MAX);

  await Promise.all(rows.map((row) => ctx.db.delete("jobItems", row._id)));

  const last = rows.at(-1);

  return rows.length < ITEM_BATCH_MAX || last === undefined ? null : { next: last.seq + 1 };
};

/** What `deleteFinishedJob` did: how many items it deleted, and whether the job went with them. */
interface FinishedDeletion {
  readonly items: number;
  readonly deleted: boolean;
}

/**
 * Deletes up to `itemBudget` of a finished job's items, and the job itself once none are left. A
 * finished job is in no kind's running count or queue, so its kind's row stays as it is.
 *
 * @throws Error when the job is queued or running, which only a defect in the caller gives.
 */
export const deleteFinishedJob = async (
  ctx: JobCtx,
  job: Doc<"jobs">,
  itemBudget: number,
): Promise<FinishedDeletion> => {
  if (job.status === "queued" || job.status === "running") {
    throw new Error(`Job ${job._id} is ${job.status}; only a finished job is deleted`);
  }

  const rows = await ctx.db
    .query("jobItems")
    .withIndex("by_job_seq", (q) => q.eq("jobId", job._id))
    .take(itemBudget + 1);

  const deleting = rows.slice(0, itemBudget);

  await Promise.all(deleting.map((row) => ctx.db.delete("jobItems", row._id)));

  const deleted = rows.length <= itemBudget;

  if (deleted) await ctx.db.delete("jobs", job._id);

  return { items: deleting.length, deleted };
};
