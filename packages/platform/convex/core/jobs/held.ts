import { v } from "convex/values";
import type { Validator } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import type { JobKind, JobPayload, PayloadOf } from "./kinds";
import type { Lease } from "./model";
import { applyEvent } from "./store";
import type { JobCtx } from "./store";

/** What a lease-checked call answers: its value while the lease holds, or why the worker stops. */
export type LeaseAnswer<Value> =
  | { readonly outcome: "held"; readonly value: Value }
  | { readonly outcome: "canceled" }
  | { readonly outcome: "lost" };

/** `LeaseAnswer` as a Convex validator, for a server function's `returns`. */
export const leaseAnswer = <Value extends Validator<unknown, "required", string>>(value: Value) =>
  v.union(
    v.object({ outcome: v.literal("held"), value }),
    v.object({ outcome: v.literal("canceled") }),
    v.object({ outcome: v.literal("lost") }),
  );

/** A running job the caller's lease holds, with its payload narrowed to the kinds asked for. */
export interface HeldJob<Kind extends JobKind> {
  readonly jobId: Id<"jobs">;
  readonly payload: PayloadOf<Kind>;
}

// SAFETY: a type predicate, not checked by the compiler. A stored payload is the `jobPayload`
// union tagged by `kind`, so a payload whose kind is one of `kinds` is exactly that kind's member.
const isOneOf =
  <Kind extends JobKind>(kinds: ReadonlyArray<Kind>) =>
  (payload: JobPayload): payload is PayloadOf<Kind> =>
    kinds.some((kind) => kind === payload.kind);

/**
 * The lease check every server function that writes for a job runs first, in its own mutation. It
 * applies the `check` event through `applyEvent`, so a canceled job ends on this call and frees
 * its slot, and a call from an older attempt answers `lost` (ADR 0012). Then it runs `write`,
 * which may itself answer `canceled`, in this same mutation, so a canceled attempt writes nothing
 * after its cancel commits.
 *
 * @throws Error when the lease holds a job of another kind, which only a defect in the server gives.
 */
export const withJobLease = async <Kind extends JobKind, Value>(
  ctx: JobCtx,
  kinds: ReadonlyArray<Kind>,
  held: Lease,
  write: (job: HeldJob<Kind>) => Promise<LeaseAnswer<Value>>,
): Promise<LeaseAnswer<Value>> => {
  const job = await ctx.db.get(held.jobId);

  if (job === null) return { outcome: "lost" };

  const { payload } = job;

  if (!isOneOf(kinds)(payload)) {
    throw new Error(`A call for ${kinds.join(" or ")} jobs got the lease of a ${payload.kind} job`);
  }

  const checked = await applyEvent(ctx, job, { type: "check", lease: held });

  if (!checked.ok) {
    if (checked.refused === "canceled" || checked.refused === "lost") {
      return { outcome: checked.refused };
    }

    throw new Error(`A lease check was refused as ${checked.refused}`);
  }

  if (checked.next.status === "canceled") return { outcome: "canceled" };

  return write({ jobId: job._id, payload });
};
