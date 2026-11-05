import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { memberIn } from "./access";
import type { MemberDoc, SessionDoc } from "./access";
import { MEMBERS_MAX, PENDING_MAX } from "./model";

type State = MemberDoc["state"];

const LIMITS = { joined: MEMBERS_MAX, pending: PENDING_MAX } as const satisfies {
  readonly [S in State]: number;
};

/** The rows of a session in one state, up to its cap. */
export const membersIn = (
  ctx: Pick<QueryCtx, "db">,
  sessionId: Id<"togetherSessions">,
  state: State,
): Promise<Array<MemberDoc>> =>
  ctx.db
    .query("togetherMembers")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId).eq("state", state))
    .take(LIMITS[state]);

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

const requireRoom = async (
  ctx: Pick<MutationCtx, "db">,
  sessionId: Id<"togetherSessions">,
  state: State,
): Promise<void> => {
  const taken = await membersIn(ctx, sessionId, state);

  if (taken.length >= LIMITS[state]) {
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
): Promise<void> => {
  if (member.state === "joined") return;

  await requireRoom(ctx, member.sessionId, "joined");
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

    await admitMember(ctx, mine);

    return "joined";
  }

  if (mine !== null) {
    const other = await ctx.db.get(mine.sessionId);

    if (other?.state === "live" && other.hostId === userId) {
      return fail("conflict", "You host a group session in this domain; leave it first");
    }

    await dropMember(ctx, mine);
  }

  await requireRoom(ctx, session._id, state);

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
