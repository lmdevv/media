import { v } from "convex/values";

import type { DomainItem } from "../../../commands/access";
import type { ContentDomain } from "../../../commands/scopes";
import type { Handlers } from "../../../commands/core/together";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { incrementCounter } from "../lib/counters";
import { fail } from "../lib/errors";
import { requirePlayable } from "../permissions/items";
import { can } from "../permissions/policy";
import type { Principal } from "../permissions/policy";
import { factsOf, refuse, requireTogether } from "./access";
import type { SessionDoc } from "./access";
import { firstAfter, firstQueued, noteQueuedFirst, queueCounter } from "./queue";
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
 * Decides `op` on `clock` at server time `now`. Play and a rate are absolute, so a repeat or a race
 * between two members changes nothing. A pause is absolute too, but always makes a new revision,
 * of a paused clock as well, as old movies' rooms did for every host command: a stalled host's
 * player plays the session on only while nothing has moved it since its own pause, and a pause
 * someone asked for since must count (ADR 0017). A seek and a skip mean something only against the
 * clock the member saw, so an older revision is stale: two members skipping at once move the
 * session on once.
 *
 * A play or a pause with a revision is one a client decided on its own, against the clock at that
 * revision, such as a stalled player's hold and its release. It is stale once the clock moved on,
 * as old rooms fenced every host command, so it never undoes a move its client had not heard of.
 * One a person asks for carries none, so it always applies (ADR 0017).
 *
 * A skip starts the next item where the clock stands past the end of the one it leaves, given
 * `carry` (`carriedPast`), so it leaves players that moved on by themselves at that end in step.
 *
 * @throws ConvexError `invalid_args` for a negative or non-finite position, or a rate outside
 *   `RATE_MIN` to `RATE_MAX`.
 */
export const stepOf = (
  clock: Clock,
  op: ControlOp,
  now: number,
  carry: Carry | null = null,
): Step => {
  const moved = (fields: Partial<Clock>, next = false): Step => ({
    kind: "move",
    clock: { ...clock, ...fields, anchorServerTime: now, revision: clock.revision + 1 },
    next,
  });

  if (op.kind === "play" || op.kind === "pause") {
    if (op.revision !== undefined && op.revision !== clock.revision) return STALE;

    if (op.kind === "play") return clock.status === "playing" ? SAME : moved({ status: "playing" });

    return moved({ status: "paused", positionAtAnchorMs: positionAt(clock, now) });
  }

  if (op.kind === "rate") {
    if (!(op.playbackRate >= RATE_MIN && op.playbackRate <= RATE_MAX)) {
      return fail("invalid_args", `A rate is from ${RATE_MIN} to ${RATE_MAX}`);
    }

    return op.playbackRate === clock.playbackRate
      ? SAME
      : moved({ playbackRate: op.playbackRate, positionAtAnchorMs: positionAt(clock, now) });
  }

  if (op.kind === "seek" && !(Number.isFinite(op.positionMs) && op.positionMs >= 0)) {
    return fail("invalid_args", "A position is a finite number of milliseconds from 0");
  }

  if (op.revision !== clock.revision) return STALE;

  return op.kind === "next"
    ? moved({ positionAtAnchorMs: carriedPast(clock, now, carry) }, true)
    : moved({ positionAtAnchorMs: op.positionMs });
};

/** How far past the end of the item it leaves a skip still carries the clock into the next one. */
export const CARRY_MAX_MS = 10_000;

/**
 * How long before a song's end the entry queued first must have been first for a skip to carry
 * into it: about the longest a player takes from the core's write to holding that song preloaded,
 * through the queue's answer, the song's details, and its stream's ticket. One that got there later
 * is not what every player preloaded.
 */
export const FIRST_BY_MS = 3_000;

/** What a skip's start past an end is decided with (`carriedPast`). */
export interface Carry {
  /** The length of the item the skip leaves. */
  readonly leavingMs: number;
  /** The length of the item it plays, or null when the core does not know one. */
  readonly nextMs: number | null;
  /** When the entry it plays got to be queued first (`queuedFirst`). */
  readonly firstSince: number;
}

/**
 * The server time the clock reached `lengthMs` on its own, playing since its latest move; null
 * for a paused clock, or one a move put at or past it, as a seek or a play after a pause there.
 */
export const reachedAt = (clock: Clock, lengthMs: number): number | null =>
  clock.status === "playing" && clock.positionAtAnchorMs < lengthMs
    ? clock.anchorServerTime + (lengthMs - clock.positionAtAnchorMs) / clock.playbackRate
    : null;

/**
 * Where the next item starts when a skip moves the session on: as far into it as the clock played
 * past the end of the item it leaves. A gapless music player moves on by itself at that end to the
 * entry queued first, which it preloaded, before the host's skip reaches the core, so that entry
 * starts for the core when it started for the players (ADR 0017).
 *
 * It carries only into the entry that was queued first by `FIRST_BY_MS` before that end and still
 * is: one that got there later, by an add in front, a removal of the entry before it, or a move,
 * is not what every player preloaded, so it starts at 0, and no one misses its start. Zero too for
 * a paused clock, a clock that did not run into the end on its own since its latest move, a skip
 * before the end, no `carry`, a clock more than `CARRY_MAX_MS` past the end, as of a session no one
 * moved on, and a carry that would reach the next item's own end.
 */
export const carriedPast = (clock: Clock, now: number, carry: Carry | null): number => {
  if (carry === null) return 0;

  const endedAt = reachedAt(clock, carry.leavingMs);

  if (endedAt === null || carry.firstSince > endedAt - FIRST_BY_MS) return 0;

  const past = positionAt(clock, now) - carry.leavingMs;
  const fits = carry.nextMs === null || past < carry.nextMs;

  return past > 0 && past <= CARRY_MAX_MS && fits ? past : 0;
};

/** The length of `item` when the core knows one, a music track's; null for any other item. */
export const itemLength = async (db: DatabaseReader, item: DomainItem): Promise<number | null> => {
  const { ref } = item;

  if (ref.type !== "track") return null;

  return (await db.get(ref.id))?.durationMs ?? null;
};

/**
 * What a skip in `session` to `entry` carries the clock past an end with, or null when `entry` is
 * not the entry queued first (`queuedFirst`): only that one is what players moved on to by
 * themselves, and only when it was queued first by `FIRST_BY_MS` before the end (`carriedPast`).
 */
const carryOf = async (
  db: DatabaseReader,
  session: SessionDoc,
  entry: Doc<"togetherEntries">,
): Promise<Carry | null> => {
  const first = session.queuedFirst;

  if (first?.entryId !== entry._id) return null;

  const [leavingMs, nextMs] = await Promise.all([
    itemLength(db, session.item),
    itemLength(db, entry.item),
  ]);

  return leavingMs === null ? null : { leavingMs, nextMs, firstSince: first.since };
};

/** The entry a skip plays: `entryId` when it is queued in `session`, or the first one queued. */
const entryToPlay = async (
  db: DatabaseReader,
  session: SessionDoc,
  entryId: Doc<"togetherEntries">["_id"] | undefined,
): Promise<Doc<"togetherEntries"> | null> => {
  if (entryId === undefined) return firstQueued(db, session._id);

  const entry = await db.get(entryId);

  return entry?.sessionId === session._id ? entry : null;
};

/** Pauses a playing session where it is, as when its host goes away; a paused one stays as it is. */
export const pauseSession = async (
  ctx: Pick<MutationCtx, "db">,
  session: SessionDoc,
  now: number,
): Promise<void> => {
  if (session.clock.status !== "playing") return;

  const step = stepOf(session.clock, { kind: "pause" }, now);

  if (step.kind === "move") await ctx.db.patch(session._id, { clock: step.clock });
};

/**
 * Applies `op` to the caller's session in `domain`, the one `sessionId` names when given (see
 * `requireTogether`), and answers the clock in force. A skip plays the first queued entry, or the
 * one it names, and takes it out of the queue; it starts `carriedPast` the end of the item it
 * leaves.
 */
export const control = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  op: ControlOp,
  sessionId?: Id<"togetherSessions">,
): Promise<Clock> => {
  const { session } = await requireTogether(ctx, caller, domain, "control", sessionId);
  const now = Date.now();
  const target = op.kind === "next" ? await entryToPlay(ctx.db, session, op.entryId) : null;
  const carry = target === null ? null : await carryOf(ctx.db, session, target);
  const step = stepOf(session.clock, op, now, carry);

  if (step.kind === "same") return session.clock;

  if (step.kind === "stale") {
    return fail("conflict", "The session moved on; apply its latest clock and try again");
  }

  if (!step.next) {
    await ctx.db.patch(session._id, { clock: step.clock });

    return step.clock;
  }

  if (target === null) {
    return op.kind === "next" && op.entryId !== undefined
      ? fail("conflict", "That entry is no longer queued; apply the latest queue and try again")
      : fail("conflict", "Nothing is queued");
  }

  await playEntry(ctx, session, target, step.clock, now);

  return step.clock;
};

/**
 * Makes `target`, queued in `session`, the entry it plays under `clock`, and takes it out of the
 * queue. The entry queued first once it plays is read before anything is written
 * (`noteQueuedFirst`): the one after it, when it was first; otherwise the same one.
 */
const playEntry = async (
  ctx: Pick<MutationCtx, "db">,
  session: SessionDoc,
  target: Doc<"togetherEntries">,
  clock: Clock,
  now: number,
): Promise<void> => {
  const head = await firstQueued(ctx.db, session._id);

  const first =
    head?._id === target._id ? await firstAfter(ctx.db, session._id, target.order) : head;

  await ctx.db.delete(target._id);
  await incrementCounter(ctx.db, queueCounter(session._id), -1);
  await ctx.db.patch(session._id, { clock, item: target.item, itemEntryId: target._id });
  await noteQueuedFirst(ctx, session, first?._id ?? null, now);
};

/**
 * How long before the end of what a session plays, on its clock, its host's player may say it
 * ended. A player follows the clock within the follower's seek threshold (`DRIFT_THRESHOLDS.seekMs`
 * in `@media/contracts`, 1.5 s): further off, it seeks back to the clock. So an engine that
 * finished a song earlier than this did not finish it where the session stands, as a device whose
 * clock jumped would, and the core refuses it; the host's player asks again at the end. Within it,
 * the core moves on at the end itself, never before (`ended`).
 */
export const ENDED_EARLY_MS = 1_500;

const MOVED_ON = "The session moved on; apply its latest clock and try again";

/** What a host's player says ended: the entry it played, under the clock it played it. */
export interface Ended {
  /** The entry, or null for the item the session started on (`itemEntryId`). */
  readonly entryId: Id<"togetherEntries"> | null;
  readonly revision: number;
}

/** Whether `session` still plays what `ended` names, under the same clock. */
const stillPlays = (session: SessionDoc, ended: Ended): boolean =>
  session.clock.revision === ended.revision && (session.itemEntryId ?? null) === ended.entryId;

/**
 * When `session`'s clock reaches the end of what it plays: now or earlier ("ended"), at a server
 * time still to come, or "never", for a paused clock before the end. A clock paused past the end,
 * as when someone paused it before anything moved it on, has ended.
 */
const endOf = (
  clock: Clock,
  lengthMs: number,
  now: number,
):
  | { readonly kind: "ended" }
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "never" } => {
  if (positionAt(clock, now) >= lengthMs) return { kind: "ended" };

  const at = reachedAt(clock, lengthMs);

  return at === null ? { kind: "never" } : { kind: "at", at };
};

/**
 * The host's player says its engine finished what the caller's session in `domain` plays, the
 * session `sessionId` names (ADR 0017). Old music's jams moved on the same way: the host's player
 * said its song ended, and the server read the queue and moved on in one write. Only the host may
 * (`advance`); a guest's player never moves a session on.
 *
 * It applies only while the session still plays that entry under that clock (`Ended`), and only
 * once the session's clock agrees: at or past the end, the session moves on now (`moveOnAtEnd`);
 * up to `ENDED_EARLY_MS` before it, the core moves it on itself when the clock gets there, as
 * `endAt`; earlier than that, or paused before the end, it fails `conflict`. An item whose length
 * the core does not know has no end on its clock, so only a skip moves it on. Answers the clock in
 * force.
 */
export const ended = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  caller: Principal,
  domain: ContentDomain,
  sessionId: Id<"togetherSessions">,
  what: Ended,
): Promise<Clock> => {
  const { session } = await requireTogether(ctx, caller, domain, "advance", sessionId);

  if (!stillPlays(session, what)) return fail("conflict", MOVED_ON);

  const lengthMs = await itemLength(ctx.db, session.item);

  if (lengthMs === null || !(lengthMs > 0)) {
    return fail("conflict", "The session has no length for what it plays; skip it instead");
  }

  const now = Date.now();
  const end = endOf(session.clock, lengthMs, now);

  if (end.kind === "ended") return moveOnAtEnd(ctx, session, now);

  if (end.kind === "never" || end.at - now > ENDED_EARLY_MS) {
    return fail("conflict", "What the session plays has not ended on its clock yet");
  }

  await ctx.scheduler.runAt(end.at, internal.core.together.clock.endAt, {
    sessionId: session._id,
    ...what,
  });

  return session.clock;
};

/**
 * The end `ended` accepted shortly before it came: moves the session on once its clock reaches
 * the end, deciding then on the queue as it is then, unless the session ended or moved since. A
 * run that comes before the end, as a scheduler a little early would, waits for it again.
 */
export const endAt = internalMutation({
  args: {
    sessionId: v.id("togetherSessions"),
    entryId: v.union(v.id("togetherEntries"), v.null()),
    revision: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, entryId, revision }) => {
    const session = await ctx.db.get(sessionId);

    if (session?.state !== "live" || !stillPlays(session, { entryId, revision })) return null;

    const lengthMs = await itemLength(ctx.db, session.item);

    if (lengthMs === null) return null;

    const now = Date.now();
    const end = endOf(session.clock, lengthMs, now);

    if (end.kind === "ended") await moveOnAtEnd(ctx, session, now);
    else if (end.kind === "at") {
      await ctx.scheduler.runAt(end.at, internal.core.together.clock.endAt, {
        sessionId,
        entryId,
        revision,
      });
    }

    return null;
  },
});

/**
 * Moves `session` on at the end of what it plays, deciding on its queue as it is now: to the
 * entry queued first, as a skip does, carried as far as the clock ran past the end
 * (`carriedPast`); or with nothing queued, paused back at the start of what it plays, as old
 * music's player stopped at the end of its queue, in one move.
 */
const moveOnAtEnd = async (
  ctx: Pick<MutationCtx, "db">,
  session: SessionDoc,
  now: number,
): Promise<Clock> => {
  const { clock } = session;
  const next = await firstQueued(ctx.db, session._id);

  if (next === null) {
    const stopped: Clock = {
      ...clock,
      status: "paused",
      positionAtAnchorMs: 0,
      anchorServerTime: now,
      revision: clock.revision + 1,
    };

    await ctx.db.patch(session._id, { clock: stopped });

    return stopped;
  }

  const carry = await carryOf(ctx.db, session, next);

  const moved: Clock = {
    ...clock,
    positionAtAnchorMs: carriedPast(clock, now, carry),
    anchorServerTime: now,
    revision: clock.revision + 1,
  };

  await playEntry(ctx, session, next, moved, now);

  return moved;
};

/**
 * Plays `item` now in the caller's session in its domain, the one `sessionId` names, from its
 * start, playing, in one write, as old music's host played a song in a jam: the caller must be
 * able to control the session, add to it, and play `item`. It plays as an entry of its own, which
 * never stays queued, so it differs from any other play of the same item (`itemEntryId`), and the
 * queue stays as it was. Answers the clock in force. Fails `conflict` once the caller is no longer
 * in that session (`requireTogether`), so a late call never plays in the session that replaced it.
 */
export const playNow = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  item: DomainItem,
  sessionId: Id<"togetherSessions">,
): Promise<Clock> => {
  const { session, place } = await requireTogether(ctx, caller, item.domain, "control", sessionId);
  const adding = can(caller, "add", factsOf(session, place));

  if (!adding.allowed) return refuse(adding);

  await requirePlayable(ctx.db, caller, item);

  const now = Date.now();

  const entryId = await ctx.db.insert("togetherEntries", {
    sessionId: session._id,
    order: 0,
    item,
    addedBy: caller.userId,
  });

  await ctx.db.delete(entryId);

  const clock: Clock = {
    ...session.clock,
    status: "playing",
    positionAtAnchorMs: 0,
    anchorServerTime: now,
    revision: session.clock.revision + 1,
  };

  await ctx.db.patch(session._id, { clock, item, itemEntryId: entryId });

  return clock;
};
