import { v } from "convex/values";

import type { ContentDomain } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { inOrder } from "../lib/inOrder";
import type { Principal } from "../permissions/policy";
import { requireTogether } from "./access";
import { pauseSession } from "./clock";
import { guestLinkDied } from "./members";
import { ABANDON_MS, BEAT_WRITE_MS, PRESENT_MS } from "./model";
import { endSession } from "./sessions";

const SWEEP_MAX = 100;

/**
 * Keeps the caller present in their session in `domain` and answers the server's clock, which a
 * client samples to place the shared clock on its own. Writes the heartbeat at most once per
 * `BEAT_WRITE_MS`, which no subscribed query reads, and the member row only when they come back,
 * so a heartbeat re-runs no one's view. A heartbeat to an ended session writes nothing.
 */
export const heartbeat = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
): Promise<{ readonly serverTime: number }> => {
  const now = Date.now();
  const { session, member } = await requireTogether(ctx, caller, domain, "see");

  if (session.state === "ended") return { serverTime: now };

  const beat = await ctx.db
    .query("togetherBeats")
    .withIndex("by_member", (q) => q.eq("memberId", member._id))
    .unique();

  if (beat === null) {
    await ctx.db.insert("togetherBeats", {
      sessionId: session._id,
      memberId: member._id,
      seenAt: now,
    });
  } else if (now - beat.seenAt >= BEAT_WRITE_MS) {
    await ctx.db.patch(beat._id, { seenAt: now });
  }

  if (member.awaySince !== null) await ctx.db.patch(member._id, { awaySince: null });

  return { serverTime: now };
};

/**
 * Marks away the members silent for `PRESENT_MS` as of `asOf` (now, or a later time a
 * test passes instead of waiting), and drops the people waiting who left and the guests whose
 * share link stopped holding. A host going away
 * pauses a playing session where it is, and the session ends if they stay away `ABANDON_MS`. Writes use the real time; `asOf` only picks
 * who is silent. A full batch runs the next one at once.
 */
export const sweep = internalMutation({
  args: { asOf: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { asOf }) => {
    const now = Date.now();

    const silent = await ctx.db
      .query("togetherBeats")
      .withIndex("by_seen", (q) => q.lt("seenAt", (asOf ?? now) - PRESENT_MS))
      .take(SWEEP_MAX);

    await inOrder(silent, async (beat) => {
      await ctx.db.delete(beat._id);

      const member = await ctx.db.get(beat.memberId);
      const session = member === null ? null : await ctx.db.get(member.sessionId);

      if (member === null || session?.state !== "live") return;

      if (member.state === "pending" || (await guestLinkDied(ctx.db, member.userId, now))) {
        await ctx.db.delete(member._id);

        return;
      }

      await ctx.db.patch(member._id, { awaySince: now });

      if (member.userId !== session.hostId) return;

      await pauseSession(ctx, session, now);
      await ctx.scheduler.runAfter(ABANDON_MS, internal.core.together.presence.abandon, {
        memberId: member._id,
        awaySince: now,
      });
    });

    if (silent.length === SWEEP_MAX) {
      await ctx.scheduler.runAfter(
        0,
        internal.core.together.presence.sweep,
        asOf === undefined ? {} : { asOf },
      );
    }

    return null;
  },
});

/**
 * Ends a session whose host went away at `awaySince` and has not come back since. A host who came
 * back, even to go away again later, keeps it.
 */
export const abandon = internalMutation({
  args: { memberId: v.id("togetherMembers"), awaySince: v.number() },
  returns: v.null(),
  handler: async (ctx, { memberId, awaySince }) => {
    const member = await ctx.db.get(memberId);
    const session = member === null ? null : await ctx.db.get(member.sessionId);

    if (member?.awaySince === awaySince && session?.hostId === member.userId) {
      await endSession(ctx, session, "abandoned");
    }

    return null;
  },
});
