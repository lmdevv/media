/**
 * Batched clean-up behind people management. Suspending, demoting, or removing someone must never
 * fail because they own too many rows (anyone can sign in, like, or create keys without limit), so
 * the handlers in `handlers/people.ts` change only the account in their own mutation, which takes
 * effect at once, and schedule these to tidy the rest a bounded batch at a time.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { inviterStillAllows } from "./lib/invites";
import { endJam, hostedJam } from "./lib/jams";
import { removeJamGuest } from "./lib/people";
import { endSession, isStale } from "./lib/sessions";

const PURGE_BATCH = 100;

/** Guest accounts removed per run: each is a few reads and deletes, and schedules its purge. */
const GUEST_BATCH = 10;

const cursor = v.union(v.string(), v.null());

/**
 * Refresh tokens deleted per session in one `purgeSessions` batch; a session with more keeps its
 * row, and the rest of its tokens, for the next batch.
 */
const TOKENS_PER_SESSION = 10;

/**
 * Deletes a person's ended sessions (`isStale`, or all of them once the person is removed), with
 * their refresh tokens, a page at a time, rescheduling until it has been through them all.
 * `endUserSessions` has already made them stop counting.
 */
export const purgeSessions = internalMutation({
  args: {
    userId: v.id("users"),
    cursor,
    /** Whether an earlier page of this pass kept a session with tokens left to delete. */
    leftover: v.optional(v.boolean()),
  },
  handler: async (ctx, { userId, cursor: from, leftover = false }) => {
    const user = await ctx.db.get(userId);

    const page = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .paginate({ cursor: from, numItems: PURGE_BATCH });

    const ended = page.page.filter((session) => user === null || isStale(session, user));

    // Whether each session went; one with more tokens than a batch deletes stays a pass longer.
    const gone = await Promise.all(
      ended.map(async (session) => {
        const tokens = await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
          .take(TOKENS_PER_SESSION);

        await Promise.all(tokens.map((token) => ctx.db.delete(token._id)));

        if (tokens.length === TOKENS_PER_SESSION) return false;

        await ctx.db.delete(session._id);

        return true;
      }),
    );

    // A session kept on any page of this pass means another pass, from the start, once this
    // one is through.
    const kept = leftover || gone.includes(false);

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.people.purgeSessions, {
        userId,
        cursor: page.continueCursor,
        leftover: kept,
      });
    } else if (kept) {
      await ctx.scheduler.runAfter(0, internal.people.purgeSessions, { userId, cursor: null });
    }
  },
});

/**
 * Revokes the open invites someone made that their role no longer allows: after a demotion, a
 * suspension, or removal. Sign-up checks the same rule, so this only tidies the invite list.
 */
export const revokeLapsedInvites = internalMutation({
  args: { inviterId: v.id("users"), cursor },
  handler: async (ctx, { inviterId, cursor: from }) => {
    const inviter = await ctx.db.get(inviterId);

    const page = await ctx.db
      .query("invites")
      .withIndex("by_creator", (q) => q.eq("createdBy", inviterId))
      .paginate({ cursor: from, numItems: PURGE_BATCH });

    await Promise.all(
      page.page
        .filter((invite) => !invite.revoked && invite.acceptedBy === undefined)
        .filter((invite) => !inviterStillAllows(inviter, invite))
        .map((invite) => ctx.db.patch(invite._id, { revoked: true })),
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.people.revokeLapsedInvites, {
        inviterId,
        cursor: page.continueCursor,
      });
    }
  },
});

/**
 * Deletes the password reset links someone made, after they were demoted, suspended, or removed.
 * Redemption checks the maker's rights again (`resetStillAllowed`), so this only tidies up.
 */
export const deleteResetsBy = internalMutation({
  args: { creatorId: v.id("users") },
  handler: async (ctx, { creatorId }) => {
    const resets = await ctx.db
      .query("passwordResets")
      .withIndex("by_creator", (q) => q.eq("createdBy", creatorId))
      .take(PURGE_BATCH);

    await Promise.all(resets.map((reset) => ctx.db.delete(reset._id)));

    if (resets.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.people.deleteResetsBy, { creatorId });
    }
  },
});

/**
 * Removes the guest accounts an ended Jam's link made, a batch at a time. Ones an admin promoted
 * leave the `by_jam_guest` range, so each batch takes the next ones.
 */
export const removeJamGuests = internalMutation({
  args: { jamId: v.id("jams") },
  handler: async (ctx, { jamId }) => {
    const jam = await ctx.db.get(jamId);

    if (jam === null) return;

    const guests = await ctx.db
      .query("users")
      .withIndex("by_jam_guest", (q) => q.eq("joinedViaJam", jamId).eq("role", "guest"))
      .take(GUEST_BATCH);

    await Promise.all(guests.map((guest) => removeJamGuest(ctx, jam, guest._id)));

    if (guests.length === GUEST_BATCH) {
      await ctx.scheduler.runAfter(0, internal.people.removeJamGuests, { jamId });
    }
  },
});

/** Revokes every API key a person has and ends the sessions they opened, for someone made a guest. */
export const revokeKeys = internalMutation({
  args: { userId: v.id("users"), cursor },
  handler: async (ctx, { userId, cursor: from }) => {
    const now = Date.now();

    const page = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .paginate({ cursor: from, numItems: PURGE_BATCH });

    await Promise.all(
      page.page
        .filter((key) => key.revokedAt === undefined)
        .map(async (key) => {
          await ctx.db.patch(key._id, { revokedAt: now, sessionId: undefined });

          if (key.sessionId !== undefined) await endSession(ctx, key.sessionId);
        }),
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.people.revokeKeys, {
        userId,
        cursor: page.continueCursor,
      });
    }
  },
});

/**
 * Who a removed person's libraries go to when a batch runs: the server's owner at that moment
 * (ownership may have moved, and the old owner been removed, since the removal), or, on a server
 * from before owners, `fallback` (whoever removed them) while that account still exists.
 */
const heirOf = async (ctx: MutationCtx, fallback: Id<"users">): Promise<Id<"users"> | null> => {
  const owner = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .first();

  if (owner !== null) return owner._id;

  return (await ctx.db.get(fallback)) === null ? null : fallback;
};

/**
 * Deletes what a removed person owned, rescheduling until it is gone: keys, devices, library
 * access, reset links, likes, history, playlists shared with them, their Jam memberships, and
 * their own playlists with those playlists' shares; their libraries move to the server's owner
 * (`heirOf`), and a Jam they host ends. Songs they added to other people's playlists stay,
 * credited to nobody. `people.remove` has already deleted the account, so none of this is
 * reachable meanwhile.
 */
export const purgeRemovedUser = internalMutation({
  args: { userId: v.id("users"), heir: v.id("users") },
  handler: async (ctx, { userId, heir }) => {
    const again = () =>
      ctx.scheduler.runAfter(0, internal.people.purgeRemovedUser, { userId, heir });

    const owned = await Promise.all([
      ctx.db
        .query("apiKeys")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
      ctx.db
        .query("devices")
        .withIndex("by_user_device", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
      ctx.db
        .query("libraryAccess")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
      ctx.db
        .query("passwordResets")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
      ctx.db
        .query("likes")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
      ctx.db
        .query("history")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
      ctx.db
        .query("playlistShares")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
      ctx.db
        .query("jamMembers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
    ]);

    // A Jam they host ends at once, so its people get their own playback back.
    const hosted = await hostedJam(ctx, userId);

    if (hosted !== null) await endJam(ctx, hosted, "host");

    // Their libraries leave the `by_owner` range as they move, so each batch takes the next ones.
    // With nobody to take them (no owner, and the remover gone too) they stay for an owner's
    // later removal of someone, or a rerun, to move.
    const to = await heirOf(ctx, heir);

    const libraries =
      to === null
        ? []
        : await ctx.db
            .query("libraries")
            .withIndex("by_owner", (q) => q.eq("ownerId", userId))
            .take(PURGE_BATCH);

    await Promise.all([
      ...owned.flat().map((doc) => ctx.db.delete(doc._id)),
      // Private libraries stay private, now to the heir; nothing on disk changes.
      ...libraries.map((library) => ctx.db.patch(library._id, { ownerId: to ?? heir })),
    ]);

    if ([...owned, libraries].some((batch) => batch.length === PURGE_BATCH)) {
      await again();

      return;
    }

    const playlist = await ctx.db
      .query("playlists")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .first();

    if (playlist === null) return;

    const [items, shares] = await Promise.all([
      ctx.db
        .query("playlistItems")
        .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
        .take(PURGE_BATCH),
      ctx.db
        .query("playlistShares")
        .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
        .take(PURGE_BATCH),
    ]);

    await Promise.all([...items, ...shares].map((doc) => ctx.db.delete(doc._id)));

    if (items.length < PURGE_BATCH && shares.length < PURGE_BATCH) {
      await ctx.db.delete(playlist._id);
    }

    await again();
  },
});
