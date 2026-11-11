import type { Id } from "../../_generated/dataModel";
import { applyEvent } from "./store";
import type { JobCtx } from "./store";

/**
 * Queues a job of `payload.kind`. While a job with the kind's dedupe key is queued or running and
 * not being canceled, it returns that one with `created: false`, so a double-clicked scan or a
 * resubmitted import runs once.
 */
export { insertJob as enqueue } from "./store";

export type Canceled =
  /** It was queued and is now canceled, or it had already finished; `status` says how. */
  | { readonly outcome: "finished"; readonly status: "succeeded" | "failed" | "canceled" }
  /** It is running; it becomes canceled at its worker's next lease call, or when its lease lapses. */
  | { readonly outcome: "canceling" }
  /** It was claimed again after the attempt named, which it no longer runs; nothing changed. */
  | { readonly outcome: "movedOn" }
  | { readonly outcome: "notFound" };

/**
 * Cancels a job at `attempt`, the attempt the canceller saw, or at whichever attempt holds it for
 * null (see the machine's `cancel` event). Canceling a canceled, finished, or canceling job
 * changes nothing.
 */
export const cancel = async (
  ctx: JobCtx,
  jobId: Id<"jobs">,
  attempt: number | null,
): Promise<Canceled> => {
  const job = await ctx.db.get("jobs", jobId);

  if (job === null) return { outcome: "notFound" };

  const result = await applyEvent(ctx, job, { type: "cancel", attempt });

  if (!result.ok && result.refused === "movedOn") return { outcome: "movedOn" };

  if (!result.ok || result.next.status === "queued") {
    throw new Error(`The machine left job ${jobId} uncanceled`);
  }

  const { status } = result.next;

  return status === "running" ? { outcome: "canceling" } : { outcome: "finished", status };
};
