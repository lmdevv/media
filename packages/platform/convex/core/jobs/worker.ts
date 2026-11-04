import { v } from "convex/values";

import { paginate } from "../lib/paginate";
import { serverMutation, serverQuery } from "../lib/serverFacing";
import { jobItem, jobKind, jobPayload } from "./kinds";
import { holds } from "./machine";
import type { Refusal, Step } from "./machine";
import { jobWork, lease } from "./model";
import { applyEvent, claimJob, kindQueue } from "./store";

const canceledAnswer = v.object({ outcome: v.literal("canceled") });

const lostAnswer = v.object({ outcome: v.literal("lost") });

const unexpected = (call: string, step: Step): never => {
  throw new Error(`${call} got an impossible step: ${JSON.stringify(step)}`);
};

const leaseRefusal = (
  call: string,
  refusal: Refusal,
): { readonly outcome: "canceled" } | { readonly outcome: "lost" } => {
  if (refusal.refused === "canceled" || refusal.refused === "lost") {
    return { outcome: refusal.refused };
  }

  return unexpected(call, { ok: false, ...refusal });
};

/**
 * For each asked kind: how many more jobs it may run now, and whether a claim would get one. Reads
 * the kind's row and one queue entry, so a pool subscribes to it and claims when a kind is ready.
 * A slot freed by the cron or a cancel changes the answer and wakes the pool.
 */
export const waiting = serverQuery({
  args: { kinds: v.array(jobKind) },
  returns: v.array(v.object({ kind: jobKind, free: v.number(), ready: v.boolean() })),
  handler: (ctx, { kinds }) =>
    Promise.all(
      kinds.map(async (kind) => {
        const queue = await kindQueue(ctx.db, kind);

        return { kind, free: queue.cap - queue.running, ready: queue.head !== null };
      }),
    ),
});

/** Claims the oldest queued job among `kinds` whose kind has a free slot. */
export const claim = serverMutation({
  args: { kinds: v.array(jobKind), workerId: v.string(), leaseMs: v.number() },
  returns: v.union(
    v.object({
      outcome: v.literal("claimed"),
      lease,
      leaseExpiresAt: v.number(),
      payload: jobPayload,
      work: jobWork,
    }),
    v.object({ outcome: v.literal("idle") }),
  ),
  handler: (ctx, { kinds, workerId, leaseMs }) => claimJob(ctx, kinds, workerId, leaseMs),
});

/**
 * Renews the lease and records what the attempt did, in one write. On an item kind, `append`
 * inserts up to 4,000 items numbered from `from`, which must equal the job's `appended`, so a
 * retried append whose first try committed answers `outOfOrder` with the count instead of
 * duplicating. `through` deletes the items below it, at most 4,000 past the current watermark.
 */
export const report = serverMutation({
  args: {
    lease,
    leaseMs: v.number(),
    message: v.optional(v.string()),
    progress: v.optional(v.object({ done: v.number(), total: v.union(v.number(), v.null()) })),
    append: v.optional(
      v.object({ from: v.number(), items: v.array(jobItem), sealed: v.boolean() }),
    ),
    through: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ outcome: v.literal("held"), leaseExpiresAt: v.number(), work: jobWork }),
    v.object({ outcome: v.literal("outOfOrder"), appended: v.number() }),
    canceledAnswer,
    lostAnswer,
  ),
  handler: async (ctx, { lease: held, ...fields }) => {
    const job = await ctx.db.get("jobs", held.jobId);

    if (job === null) return { outcome: "lost" as const };

    const result = await applyEvent(ctx, job, { type: "report", lease: held, report: fields });

    if (!result.ok) {
      return result.refused === "outOfOrder"
        ? { outcome: "outOfOrder" as const, appended: result.appended }
        : leaseRefusal("report", result);
    }

    const { next } = result;

    if (next.status === "running") {
      return { outcome: "held" as const, leaseExpiresAt: next.leaseExpiresAt, work: next.work };
    }

    return next.status === "canceled"
      ? { outcome: "canceled" as const }
      : unexpected("report", result);
  },
});

const ITEMS_PAGE_MAX = 1000;

/**
 * Up to `limit` (at most 1,000) of a held job's items from seq `from`, in seq order. The seq is the
 * cursor. A resumed worker starts at the `work.done` its claim returned.
 */
export const items = serverQuery({
  args: { lease, from: v.number(), limit: v.number() },
  returns: v.union(
    v.object({
      outcome: v.literal("held"),
      items: v.array(v.object({ seq: v.number(), item: jobItem })),
    }),
    canceledAnswer,
    lostAnswer,
  ),
  handler: async (ctx, { lease: held, from, limit }) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ITEMS_PAGE_MAX) {
      throw new Error(`items returns 1 to ${ITEMS_PAGE_MAX} items a call; got ${limit}`);
    }

    const job = await ctx.db.get("jobs", held.jobId);

    if (job === null) return { outcome: "lost" as const };

    const check = holds(job, held);

    if (!check.held) return { outcome: check.refused };

    if (check.job.cancelRequestedAt !== null) return { outcome: "canceled" as const };

    const page = await paginate(
      ctx.db,
      {
        table: "jobItems",
        index: "by_job_seq",
        range: (q) => q.eq("jobId", held.jobId).gte("seq", from),
      },
      { numItems: limit, cursor: null },
    );

    return {
      outcome: "held" as const,
      items: page.page.map((row) => ({ seq: row.seq, item: row.item })),
    };
  },
});

/**
 * Ends the held attempt. A repeat with the same lease and outcome answers `settled` again, so a
 * worker may retry a finish whose answer it lost. Success of an item kind needs every appended
 * item done and the items sealed; otherwise it answers `unfinished` and writes nothing.
 */
export const finish = serverMutation({
  args: {
    lease,
    end: v.union(
      v.object({ outcome: v.literal("succeeded"), message: v.optional(v.string()) }),
      v.object({ outcome: v.literal("failed"), error: v.string(), retry: v.boolean() }),
    ),
  },
  returns: v.union(
    v.object({
      outcome: v.literal("settled"),
      status: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("queued")),
    }),
    v.object({ outcome: v.literal("unfinished"), work: jobWork }),
    canceledAnswer,
    lostAnswer,
  ),
  handler: async (ctx, { lease: held, end }) => {
    const job = await ctx.db.get("jobs", held.jobId);

    if (job === null) return { outcome: "lost" as const };

    const result = await applyEvent(ctx, job, { type: "finish", lease: held, finish: end });

    if (!result.ok) {
      return result.refused === "unfinished"
        ? { outcome: "unfinished" as const, work: result.work }
        : leaseRefusal("finish", result);
    }

    const { status } = result.next;

    if (status === "canceled") return { outcome: "canceled" as const };

    return status === "running"
      ? unexpected("finish", result)
      : { outcome: "settled" as const, status };
  },
});
