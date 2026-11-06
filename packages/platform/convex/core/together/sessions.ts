import { v } from "convex/values";

import { domainItem } from "../../../commands/access";
import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import { fail } from "../lib/errors";
import { deleteCounter } from "../lib/counters";
import { takeAttempt } from "../lib/rateLimit";
import { requirePlayable } from "../permissions/items";
import { can } from "../permissions/policy";
import { refuse } from "./access";
import type { SessionDoc } from "./access";
import { startingClock } from "./clock";
import { queueCounter } from "./queue";
import { dropBeats, enter } from "./members";
import { CREATES_PER_HOUR, ENDED_KEEP_MS, MEMBERS_MAX, PENDING_MAX, joinSetting } from "./model";

const PURGE_BATCH = 500;

/**
 * `create`'s write, once its action made the link's secret. Checks the caller again with API keys
 * refused, then `start` and the item, leaves the caller's place as a guest in another session of
 * the domain, and opens the session paused at the item's start with the caller as its host.
 */
export const open = internalMutation({
  args: {
    item: domainItem,
    secret: v.string(),
    join: joinSetting,
    control: v.boolean(),
    add: v.boolean(),
  },
  returns: v.id("togetherSessions"),
  handler: async (ctx, { item, secret, join, control, add }) => {
    const caller = refuseKeys(await requireCaller(ctx, "signed-in"));
    const now = Date.now();
    const decision = can(caller, "start", { on: "together", domain: item.domain, session: null });

    if (!decision.allowed) return refuse(decision);

    await requirePlayable(ctx.db, caller, item);

    const limit = { identifier: `together-create:${caller.userId}`, perHour: CREATES_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, now))) {
      return fail("rate_limited", "You started too many group sessions; wait a few minutes");
    }

    const sessionId = await ctx.db.insert("togetherSessions", {
      hostId: caller.userId,
      linkSecret: secret,
      settings: { join, control, add },
      blocked: [],
      clock: startingClock(now),
      item,
      state: "live",
    });

    const session = (await ctx.db.get(sessionId)) ?? fail("not_found", "No such group session");

    await enter(ctx, session, caller.userId, "joined", now);

    return sessionId;
  },
});

/**
 * Ends a live session for everyone: every member's view turns ended at once, heartbeats stop
 * counting, and the rows stay for `ENDED_KEEP_MS` before `purge` deletes them. Ending an ended
 * session changes nothing.
 */
export const endSession = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  session: SessionDoc,
  reason: "host-left" | "abandoned",
): Promise<void> => {
  if (session.state === "ended") return;

  const { _id: sessionId, hostId, linkSecret, settings, blocked, clock, item } = session;

  await ctx.db.replace(sessionId, {
    hostId,
    linkSecret,
    settings,
    blocked,
    clock,
    item,
    state: "ended",
    reason,
  });

  await dropBeats(ctx, sessionId);
  await ctx.scheduler.runAfter(ENDED_KEEP_MS, internal.core.together.sessions.purge, {
    sessionId,
  });
};

/**
 * Deletes an ended session a batch at a time: its queue, then its members, then the session, and
 * its queue's count.
 */
export const purge = internalMutation({
  args: { sessionId: v.id("togetherSessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);

    if (session?.state !== "ended") return null;

    const entries = await ctx.db
      .query("togetherEntries")
      .withIndex("by_session_order", (q) => q.eq("sessionId", sessionId))
      .take(PURGE_BATCH);

    await Promise.all(entries.map(async (entry) => ctx.db.delete(entry._id)));

    if (entries.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.core.together.sessions.purge, { sessionId });

      return null;
    }

    const members = await ctx.db
      .query("togetherMembers")
      .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId))
      .take(MEMBERS_MAX + PENDING_MAX);

    await dropBeats(ctx, sessionId);
    await Promise.all(members.map(async (member) => ctx.db.delete(member._id)));
    await deleteCounter(ctx.db, queueCounter(sessionId));
    await ctx.db.delete(sessionId);

    return null;
  },
});
