/**
 * What a domain calls from its own functions: queue a job, cancel one, and check a lease inside a
 * domain function the server calls with it, such as a scanner callback.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { isPayloadOf } from "./kinds";
import type { JobKind, JobPayload, PayloadOf } from "./kinds";
import { holds } from "./machine";
import type { Lease } from "./model";
import { applyEvent, insertJob, leasedJob } from "./store";
import type { Enqueued } from "./store";

/**
 * Queues a job of `payload.kind`. While a job with the kind's dedupe key is queued or running, it
 * returns that one with `created: false`, so a double-clicked scan or a resubmitted import runs
 * once.
 */
export const enqueue = (ctx: MutationCtx, payload: JobPayload): Promise<Enqueued> =>
  insertJob(ctx, payload);

export type Canceled =
  /** It was queued and is now canceled, or it had already finished; `status` says how. */
  | { readonly outcome: "finished"; readonly status: "succeeded" | "failed" | "canceled" }
  /** It is running; it becomes canceled at its worker's next lease call, or when its lease lapses. */
  | { readonly outcome: "canceling" }
  | { readonly outcome: "notFound" };

/** Cancels a job. Canceling a canceled, finished, or canceling job changes nothing. */
export const cancel = async (ctx: MutationCtx, jobId: Id<"jobs">): Promise<Canceled> => {
  const job = await ctx.db.get("jobs", jobId);

  if (job === null) return { outcome: "notFound" };

  const result = await applyEvent(ctx, job, { type: "cancel" });

  if (!result.ok || result.next.status === "queued") {
    throw new Error(`The machine left job ${jobId} uncanceled`);
  }

  const { status } = result.next;

  return status === "running" ? { outcome: "canceling" } : { outcome: "finished", status };
};

export type LeaseCheck<Kind extends JobKind> =
  | { readonly held: true; readonly payload: PayloadOf<Kind> }
  | { readonly held: false; readonly refused: "canceled" | "lost" };

/**
 * Checks, inside a domain function the server calls, that `lease` holds a running job of `kind`,
 * by the same rule every lease call runs. A requested cancel answers `canceled`. It neither renews
 * the lease nor records the cancel; the worker's next `report` does both.
 *
 * @throws Error when the lease holds a job of another kind: the worker sent the wrong lease.
 */
export const holdLease = async <Kind extends JobKind>(
  ctx: QueryCtx | MutationCtx,
  lease: Lease,
  kind: Kind,
): Promise<LeaseCheck<Kind>> => {
  const job = await leasedJob(ctx.db, lease);

  if (job === null) return { held: false, refused: "lost" };

  const held = holds(job, lease);

  if (!held.held) return held;

  if (held.job.cancelRequestedAt !== null) return { held: false, refused: "canceled" };

  const { payload } = held.job;

  if (!isPayloadOf(payload, kind)) {
    throw new Error(`A ${kind} lease names a ${payload.kind} job`);
  }

  return { held: true, payload };
};
