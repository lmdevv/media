/**
 * What a domain calls from its own functions: queue a job and cancel one. A domain function the
 * server calls with a lease, such as a scanner callback, checks it with `machine.holds`, the rule
 * every lease call runs; the first such callback adds its helper here.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { JobPayload } from "./kinds";
import { applyEvent, insertJob } from "./store";
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
