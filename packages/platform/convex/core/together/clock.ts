import type { ContentDomain } from "../../../commands/scopes";
import type { Handlers } from "../../../commands/core/together";
import type { MutationCtx } from "../../_generated/server";
import { incrementCounter } from "../lib/counters";
import { fail } from "../lib/errors";
import type { Principal } from "../permissions/policy";
import { requireTogether } from "./access";
import type { SessionDoc } from "./access";
import { queueCounter } from "./queue";
import { RATE_MAX, RATE_MIN } from "./model";
import type { Clock } from "./model";

/** One move a member asks of the clock. */
export type ControlOp = Parameters<Handlers["control"]>[1]["op"];

/** The shared position at server time `serverNow`; a playing clock advances at its rate. */
export const positionAt = (clock: Clock, serverNow: number): number =>
  clock.status === "playing"
    ? clock.positionAtAnchorMs +
      Math.max(0, serverNow - clock.anchorServerTime) * clock.playbackRate
    : clock.positionAtAnchorMs;

/** A clock paused, at rate 1, at the start of its item. */
export const startingClock = (now: number): Clock => ({
  status: "paused",
  positionAtAnchorMs: 0,
  anchorServerTime: now,
  playbackRate: 1,
  revision: 0,
});

/**
 * What a move does to a clock: nothing when the clock is already so, nothing when it was asked of
 * an older clock than this one, or a new clock, which may also move the session to its next item.
 */
export type Step =
  | { readonly kind: "same" }
  | { readonly kind: "stale" }
  | { readonly kind: "move"; readonly clock: Clock; readonly next: boolean };

const SAME: Step = { kind: "same" };

const STALE: Step = { kind: "stale" };

/**
 * Decides `op` on `clock` at server time `now`. Play, pause, and a rate are absolute, so a repeat
 * or a race between two members changes nothing. A seek and a skip mean something only against
 * the clock the member saw, so an older revision is stale: two members skipping at once move the
 * session on once.
 *
 * @throws ConvexError `invalid_args` for a negative or non-finite position, or a rate outside
 *   `RATE_MIN` to `RATE_MAX`.
 */
export const stepOf = (clock: Clock, op: ControlOp, now: number): Step => {
  const moved = (fields: Partial<Clock>, next = false): Step => ({
    kind: "move",
    clock: { ...clock, ...fields, anchorServerTime: now, revision: clock.revision + 1 },
    next,
  });

  if (op.kind === "play") return clock.status === "playing" ? SAME : moved({ status: "playing" });

  if (op.kind === "pause") {
    return clock.status === "paused"
      ? SAME
      : moved({ status: "paused", positionAtAnchorMs: positionAt(clock, now) });
  }

  if (op.kind === "rate") {
    if (!(op.playbackRate >= RATE_MIN && op.playbackRate <= RATE_MAX)) {
      return fail("invalid_args", `A rate is from ${RATE_MIN} to ${RATE_MAX}`);
    }

    return op.playbackRate === clock.playbackRate
      ? SAME
      : moved({ playbackRate: op.playbackRate, positionAtAnchorMs: positionAt(clock, now) });
  }

  if (op.revision !== clock.revision) return STALE;

  if (op.kind === "next") return moved({ positionAtAnchorMs: 0 }, true);

  return Number.isFinite(op.positionMs) && op.positionMs >= 0
    ? moved({ positionAtAnchorMs: op.positionMs })
    : fail("invalid_args", "A position is a finite number of milliseconds from 0");
};

/** Pauses a playing session where it is, as when its host goes away. */
export const pauseSession = async (
  ctx: Pick<MutationCtx, "db">,
  session: SessionDoc,
  now: number,
): Promise<void> => {
  const step = stepOf(session.clock, { kind: "pause" }, now);

  if (step.kind === "move") await ctx.db.patch(session._id, { clock: step.clock });
};

/**
 * Applies `op` to the caller's session in `domain` and answers the clock in force. A skip plays
 * the first queued item from its start and takes it out of the queue.
 */
export const control = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  op: ControlOp,
): Promise<Clock> => {
  const { session } = await requireTogether(ctx, caller, domain, "control");
  const step = stepOf(session.clock, op, Date.now());

  if (step.kind === "same") return session.clock;

  if (step.kind === "stale") {
    return fail("conflict", "The session moved on; apply its latest clock and try again");
  }

  if (!step.next) {
    await ctx.db.patch(session._id, { clock: step.clock });

    return step.clock;
  }

  const entry =
    (await ctx.db
      .query("togetherEntries")
      .withIndex("by_session_order", (q) => q.eq("sessionId", session._id))
      .first()) ?? fail("conflict", "Nothing is queued");

  await ctx.db.delete(entry._id);
  await incrementCounter(ctx.db, queueCounter(session._id), -1);
  await ctx.db.patch(session._id, { clock: step.clock, item: entry.item });

  return step.clock;
};
