/**
 * What changing or removing a person does beyond their own row, shared by the people handlers and
 * by Jams, whose guest accounts go when the Jam does.
 */
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { endJam, hostedJam } from "./jams";
import { findSession } from "./playback";
import { endUserSessions } from "./sessions";
import type { ReadCtx } from "./viewer";
import { roleOf } from "./viewer";

/** The server's owner, if a migration or the first sign-up has named one. */
export const findOwner = (ctx: ReadCtx): Promise<Doc<"users"> | null> =>
  ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .first();

/**
 * Voids the password reset links around a change to a person: the ones made for them, since who
 * may reset them can change with it, and, in batches, the ones they made, since their own rights
 * changed. Redemption re-checks both anyway (`resetStillAllowed`).
 */
export const voidResets = async (ctx: MutationCtx, personId: Id<"users">): Promise<void> => {
  const own = await ctx.db
    .query("passwordResets")
    .withIndex("by_user", (q) => q.eq("userId", personId))
    .take(10);

  await Promise.all(own.map((reset) => ctx.db.delete(reset._id)));
  await ctx.scheduler.runAfter(0, internal.people.deleteResetsBy, { creatorId: personId });
};

/**
 * Tidies the invite list after someone loses the right to their open invites. Sign-up already
 * refuses those invites (`inviterStillAllows`), so this can run later, in batches.
 */
export const revokeLapsedInvites = async (
  ctx: MutationCtx,
  inviterId: Id<"users">,
): Promise<void> => {
  await ctx.scheduler.runAfter(0, internal.people.revokeLapsedInvites, {
    inviterId,
    cursor: null,
  });
};

/**
 * Ends the Jam someone hosts, if any, when they are suspended or removed: its people get their
 * own playback back, and its guest accounts go.
 */
export const endHostedJam = async (ctx: MutationCtx, userId: Id<"users">): Promise<void> => {
  const jam = await hostedJam(ctx, userId);

  if (jam !== null) await endJam(ctx, jam, "host");
};

/**
 * Removes a person's account at once, and schedules the rest. Only the account, its sign-in
 * method, and its one playback session and queue go here: a person has one password account with
 * at most a code or two. Everything they could create without limit (keys, devices, likes,
 * history, playlists) goes in batches after, which cannot fail the removal; with the account
 * gone, none of it is reachable meanwhile. Their libraries go to `heir`.
 */
export const removeAccount = async (
  ctx: MutationCtx,
  user: Doc<"users">,
  heir: Id<"users">,
): Promise<void> => {
  const [accounts, playback, queue] = await Promise.all([
    ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id))
      .take(10),
    findSession(ctx, user._id),
    ctx.db
      .query("playbackQueues")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique(),
  ]);

  const codes = await Promise.all(
    accounts.map((account) =>
      ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", account._id))
        .take(10),
    ),
  );

  await endUserSessions(ctx, user._id);
  await endHostedJam(ctx, user._id);

  await Promise.all([
    // Deleting the account frees the email for a new invite.
    ...[...accounts, ...codes.flat()].map((doc) => ctx.db.delete(doc._id)),
    ...[playback, queue].flatMap((row) => (row === null ? [] : [ctx.db.delete(row._id)])),
  ]);

  await ctx.db.delete(user._id);
  await revokeLapsedInvites(ctx, user._id);
  await voidResets(ctx, user._id);
  await ctx.scheduler.runAfter(0, internal.people.purgeRemovedUser, { userId: user._id, heir });
};

/**
 * Whether `user` is a guest account a link to `jam` made, which goes with that Jam. One an admin
 * has since promoted stays.
 */
const isGuestOf = (user: Doc<"users">, jam: Doc<"jams">): boolean =>
  user.joinedViaJam === jam._id && roleOf(user) === "guest";

/**
 * Removes `userId`'s account if it is a guest account `jam`'s link made: when the host removes or
 * turns them away, and when the Jam ends. Anyone else keeps their account.
 */
export const removeJamGuest = async (
  ctx: MutationCtx,
  jam: Doc<"jams">,
  userId: Id<"users">,
): Promise<void> => {
  const user = await ctx.db.get(userId);

  if (user === null || !isGuestOf(user, jam)) return;

  // A guest owns no libraries; the heir only has to exist.
  await removeAccount(ctx, user, (await findOwner(ctx))?._id ?? jam.hostId);
};
