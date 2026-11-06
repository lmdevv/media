import { v } from "convex/values";

import { contentDomain } from "../../../commands/scopes";
import type { Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../../_generated/server";
import { requireCaller } from "../auth/caller";
import { linkHolds } from "../guests/standing";
import { fail } from "../lib/errors";
import { memberIn, requireTogether } from "./access";
import type { MemberDoc, SessionDoc } from "./access";
import { BLOCKED_MAX, MEMBERS_MAX, PENDING_MAX } from "./model";

type State = MemberDoc["state"];

const LIMITS = { joined: MEMBERS_MAX, pending: PENDING_MAX } as const satisfies {
  readonly [S in State]: number;
};

export const guestLinkDied = async (
  db: DatabaseReader,
  userId: Id<"users">,
  now: number,
): Promise<boolean> => {
  const user = await db.get(userId);

  return user?.kind === "person" && user.role === "guest" && !(await linkHolds(db, user, now));
};

interface Seats {
  readonly seated: Array<MemberDoc>;
  readonly lapsed: Array<MemberDoc>;
}

const seatsIn = async (
  db: DatabaseReader,
  sessionId: Id<"togetherSessions">,
  state: State,
  now: number,
): Promise<Seats> => {
  const rows = await db
    .query("togetherMembers")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId).eq("state", state))
    .take(LIMITS[state]);

  const judged = await Promise.all(
    rows.map(async (row) => ({ row, died: await guestLinkDied(db, row.userId, now) })),
  );

  return {
    seated: judged.flatMap(({ row, died }) => (died ? [] : [row])),
    lapsed: judged.flatMap(({ row, died }) => (died ? [row] : [])),
  };
};

export const membersIn = async (
  ctx: Pick<QueryCtx, "db">,
  sessionId: Id<"togetherSessions">,
  state: State,
  now: number,
): Promise<Array<MemberDoc>> => (await seatsIn(ctx.db, sessionId, state, now)).seated;

/** Deletes a member's heartbeat, which exists only while they are present. */
export const dropBeat = async (
  ctx: Pick<MutationCtx, "db">,
  memberId: Id<"togetherMembers">,
): Promise<void> => {
  const beat = await ctx.db
    .query("togetherBeats")
    .withIndex("by_member", (q) => q.eq("memberId", memberId))
    .unique();

  if (beat !== null) await ctx.db.delete(beat._id);
};

/** Deletes every heartbeat of a session, at most one per member. */
export const dropBeats = async (
  ctx: Pick<MutationCtx, "db">,
  sessionId: Id<"togetherSessions">,
): Promise<void> => {
  const beats = await ctx.db
    .query("togetherBeats")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(MEMBERS_MAX + PENDING_MAX);

  await Promise.all(beats.map(async (beat) => ctx.db.delete(beat._id)));
};

/** Deletes a member's row and heartbeat. */
export const dropMember = async (
  ctx: Pick<MutationCtx, "db">,
  member: MemberDoc,
): Promise<void> => {
  await dropBeat(ctx, member._id);
  await ctx.db.delete(member._id);
};

const makeRoom = async (
  ctx: Pick<MutationCtx, "db">,
  sessionId: Id<"togetherSessions">,
  state: State,
  now: number,
): Promise<void> => {
  const { seated, lapsed } = await seatsIn(ctx.db, sessionId, state, now);

  await Promise.all(lapsed.map(async (row) => dropMember(ctx, row)));

  if (seated.length >= LIMITS[state]) {
    fail(
      "conflict",
      state === "joined" ? "This group session is full" : "Too many people are waiting to join",
    );
  }
};

/** Lets a waiting member in, under the session's cap. */
export const admitMember = async (
  ctx: Pick<MutationCtx, "db">,
  member: MemberDoc,
  now: number,
): Promise<void> => {
  if (member.state === "joined") return;

  await makeRoom(ctx, member.sessionId, "joined", now);
  await ctx.db.patch(member._id, { state: "joined" });
};

/**
 * Puts `userId` in the live `session` as `state`, present, and answers where they stand. The one
 * way a row enters a session: `create` and `join`. A member keeps
 * their place, and a waiting one is let in when `state` is `joined`. Their row in another session
 * of the domain goes first, which fails `conflict` while they host that session and it is live.
 */
export const enter = async (
  ctx: Pick<MutationCtx, "db">,
  session: SessionDoc,
  userId: Id<"users">,
  state: State,
  now: number,
): Promise<State> => {
  const mine = await memberIn(ctx.db, userId, session.item.domain);

  if (mine?.sessionId === session._id) {
    if (mine.state === "joined" || state === "pending") return mine.state;

    await admitMember(ctx, mine, now);

    return "joined";
  }

  if (mine !== null) {
    const other = await ctx.db.get(mine.sessionId);

    if (other?.state === "live" && other.hostId === userId) {
      return fail("conflict", "You host a group session in this domain; leave it first");
    }

    await dropMember(ctx, mine);
  }

  await makeRoom(ctx, session._id, state, now);

  const memberId = await ctx.db.insert("togetherMembers", {
    sessionId: session._id,
    userId,
    domain: session.item.domain,
    state,
    awaySince: null,
  });

  await ctx.db.insert("togetherBeats", { sessionId: session._id, memberId, seenAt: now });

  return state;
};

/**
 * `block`'s write, as the caller hosting the session in `domain`: takes `userId` out of it, joined
 * or waiting, and keeps its link from letting them in again while the list of people turned away
 * has room. Answers whether it does; the removal commits either way, so a full list never keeps
 * someone in the session.
 */
export const turnAway = internalMutation({
  args: { domain: contentDomain, userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, { domain, userId }) => {
    const caller = await requireCaller(ctx, "signed-in");
    const { session } = await requireTogether(ctx, caller, domain, "manage");

    if (userId === session.hostId) {
      return fail("invalid_args", "The host cannot remove themselves; leave to end the session");
    }

    const row = await memberIn(ctx.db, userId, domain);

    if (row?.sessionId === session._id) await dropMember(ctx, row);

    if (session.blocked.includes(userId)) return true;

    if (session.blocked.length >= BLOCKED_MAX) return false;

    await ctx.db.patch(session._id, { blocked: [...session.blocked, userId] });

    return true;
  },
});
