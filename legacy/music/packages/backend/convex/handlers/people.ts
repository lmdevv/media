/**
 * People management for admins: roles, suspension, password reset links, removal, and ownership
 * transfer. Who may do what comes from `@music/commands/permissions`; this module adds the rules
 * that need the database, such as never leaving the server without an active admin.
 */
import {
  assignableRoles,
  can,
  canManagePerson,
  canTransferOwnership,
} from "@music/commands/permissions";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { randomToken, sha256Hex } from "../lib/crypto";
import { fail } from "../lib/errors";
import { findSession } from "../lib/playback";
import { endUserSessions } from "../lib/sessions";
import { listensBeyond, loadPerson, roleOf } from "../lib/viewer";
import type { Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

/** How long a password reset link works. */
const RESET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The latest sign of life: a sign-in, a player heartbeat, a playback change, or an API key use.
 * Each comes from an index on the person, so this reads a few rows per person.
 */
const lastActiveAt = async (ctx: QueryCtx, userId: Id<"users">): Promise<number | null> => {
  const [device, session, key, playback] = await Promise.all([
    ctx.db
      .query("devices")
      .withIndex("by_user_last_seen", (q) => q.eq("userId", userId))
      .order("desc")
      .first(),
    // Within one person the index orders sessions by creation, so this is the latest sign-in.
    ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .first(),
    // Keys never used sort first, so the last one is the most recently used.
    ctx.db
      .query("apiKeys")
      .withIndex("by_user_last_used", (q) => q.eq("userId", userId))
      .order("desc")
      .first(),
    findSession(ctx, userId),
  ]);

  const times = [
    device?.lastSeenAt,
    playback?.updatedAt,
    session?._creationTime,
    key?.lastUsedAt,
  ].filter((time) => time !== undefined);

  return times.length === 0 ? null : Math.max(...times);
};

const presentPerson = async (ctx: QueryCtx, doc: Doc<"users">) => ({
  id: doc._id,
  email: doc.email ?? "",
  name: doc.name ?? null,
  role: roleOf(doc),
  suspended: doc.suspendedAt !== undefined,
  createdAt: doc._creationTime,
  lastActiveAt: await lastActiveAt(ctx, doc._id),
});

/** A person the viewer may manage (see `canManagePerson`), or a `forbidden` failure saying why. */
const managedPerson = async (ctx: QueryCtx, viewer: Viewer, id: string): Promise<Doc<"users">> => {
  const user = await loadPerson(ctx, id);

  if (canManagePerson(viewer, { id: user._id, role: roleOf(user) })) return user;

  if (user._id === viewer.id) {
    return fail("forbidden", "You can't change your own account here; ask another admin");
  }

  if (roleOf(user) === "admin") return fail("forbidden", "Only the owner can change an admin");

  return fail(
    "forbidden",
    "The owner's account can't be changed. The owner can transfer ownership first.",
  );
};

/**
 * Fails unless someone other than `leaving` can still run the server: an owner or admin who is
 * not suspended. The owner can never be demoted, suspended, or removed, so this only matters
 * on a server that predates owners, until its migration names one.
 */
const keepAnAdmin = async (ctx: QueryCtx, leaving: Doc<"users">): Promise<void> => {
  if (roleOf(leaving) !== "admin" || (await findOwner(ctx)) !== null) return;

  const others = await Promise.all(
    (["owner", "admin"] as const).map((role) =>
      ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", role))
        .collect(),
    ),
  );

  const active = others
    .flat()
    .filter((user) => user._id !== leaving._id && user.suspendedAt === undefined);

  if (active.length === 0) {
    fail("conflict", "This is the last admin. Make someone else an admin first.");
  }
};

/**
 * Voids the password reset links around a change to a person: the ones made for them, since who
 * may reset them can change with it, and, in batches, the ones they made, since their own rights
 * changed. Redemption re-checks both anyway (`resetStillAllowed`).
 */
const voidResets = async (ctx: MutationCtx, personId: Id<"users">): Promise<void> => {
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
const revokeLapsedInvites = async (ctx: MutationCtx, inviterId: Id<"users">): Promise<void> => {
  await ctx.scheduler.runAfter(0, internal.people.revokeLapsedInvites, {
    inviterId,
    cursor: null,
  });
};

/** The server's owner, if a migration or the first sign-up has named one. */
const findOwner = (ctx: QueryCtx): Promise<Doc<"users"> | null> =>
  ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .first();

/**
 * Creates a one-time reset link for `userId`, replacing any earlier unused one. Returns the token,
 * which is never stored.
 */
export const createPasswordReset = async (
  ctx: MutationCtx,
  userId: Id<"users">,
  createdBy: Id<"users"> | undefined,
): Promise<{ readonly token: string; readonly expiresAt: number }> => {
  const earlier = await ctx.db
    .query("passwordResets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  await Promise.all(earlier.map((reset) => ctx.db.delete(reset._id)));

  const token = randomToken(32);
  const expiresAt = Date.now() + RESET_TTL_MS;

  await ctx.db.insert("passwordResets", {
    userId,
    hash: await sha256Hex(token),
    createdBy,
    expiresAt,
  });

  return { token, expiresAt };
};

export const peopleQueries = {
  "people.list": async (ctx) => {
    const users = await ctx.db.query("users").collect();

    return Promise.all(users.map((user) => presentPerson(ctx, user)));
  },
} satisfies Partial<QueryHandlers>;

export const peopleMutations = {
  "people.role": async (ctx, viewer, args) => {
    const user = await managedPerson(ctx, viewer, args.userId);

    if (!assignableRoles(viewer.role).includes(args.role)) {
      return fail("forbidden", `You can't make someone ${args.role}`);
    }

    if (roleOf(user) === args.role) return ok;

    if (args.role !== "admin") await keepAnAdmin(ctx, user);

    // Guests have no API keys: every key made so far stops at once, with the sessions it opened
    // (`keysValidAfter`), and stays stopped after a later promotion, while the batches below
    // revoke the rows.
    await ctx.db.patch(
      user._id,
      args.role === "guest" ? { role: args.role, keysValidAfter: Date.now() } : { role: args.role },
    );
    await revokeLapsedInvites(ctx, user._id);
    await voidResets(ctx, user._id);

    // Guests have no API keys. Key sign-in refuses guests at once; the keys are revoked, and the
    // sessions they opened ended, in batches, so a promotion does not revive them. Password
    // sessions stay: a guest still listens.
    if (args.role === "guest") {
      await ctx.scheduler.runAfter(0, internal.people.revokeKeys, {
        userId: user._id,
        cursor: null,
      });
    }

    return ok;
  },

  "people.suspend": async (ctx, viewer, args) => {
    const user = await managedPerson(ctx, viewer, args.userId);

    await keepAnAdmin(ctx, user);

    await ctx.db.patch(user._id, { suspendedAt: user.suspendedAt ?? Date.now() });
    await revokeLapsedInvites(ctx, user._id);
    await voidResets(ctx, user._id);

    // API keys stay, refusing to sign in until the person is unsuspended. Stream URLs already
    // signed keep working until they expire, as after any revocation.
    await endUserSessions(ctx, user._id);

    return ok;
  },

  "people.unsuspend": async (ctx, viewer, args) => {
    const user = await managedPerson(ctx, viewer, args.userId);

    if (user.suspendedAt === undefined) return ok;

    // A sign-in that raced the suspension made a session after it ended the others; it must not
    // come back to life with the account.
    await endUserSessions(ctx, user._id);
    await ctx.db.patch(user._id, { suspendedAt: undefined });

    return ok;
  },

  "people.reset": async (ctx, viewer, args) => {
    const user = await managedPerson(ctx, viewer, args.userId);

    // A reset link hands over the account, and with it every library the person can hear.
    if (!can(viewer.role, "owner") && (await listensBeyond(ctx, viewer.user, user))) {
      return fail(
        "forbidden",
        "Only the owner can reset someone who can listen to libraries you can't",
      );
    }

    const reset = await createPasswordReset(ctx, user._id, viewer.id);

    return { userId: user._id, ...reset };
  },

  "people.remove": async (ctx, viewer, args) => {
    const user = await managedPerson(ctx, viewer, args.userId);

    await keepAnAdmin(ctx, user);

    // A server from before owners has none until its migration runs; the remover takes over.
    const heir = (await findOwner(ctx))?._id ?? viewer.id;

    // Only the account, its sign-in method, and its one playback session and queue go here: a person has
    // one password account with at most a code or two. Everything they could create without
    // limit (keys, devices, likes, history, playlists) goes in batches after, which cannot fail
    // the removal; with the account gone, none of it is reachable meanwhile.
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

    await Promise.all([
      // Deleting the account frees the email for a new invite.
      ...[...accounts, ...codes.flat()].map((doc) => ctx.db.delete(doc._id)),
      ...[playback, queue].flatMap((row) => (row === null ? [] : [ctx.db.delete(row._id)])),
    ]);

    await ctx.db.delete(user._id);
    await revokeLapsedInvites(ctx, user._id);
    await voidResets(ctx, user._id);
    await ctx.scheduler.runAfter(0, internal.people.purgeRemovedUser, { userId: user._id, heir });

    return ok;
  },

  "people.transfer": async (ctx, viewer, args) => {
    const user = await loadPerson(ctx, args.userId);
    const target = { id: user._id, role: roleOf(user), suspended: user.suspendedAt !== undefined };

    if (!canTransferOwnership(viewer, target)) {
      return fail("invalid_args", "Ownership can only go to an active admin");
    }

    await ctx.db.patch(user._id, { role: "owner" });
    await ctx.db.patch(viewer.id, { role: "admin" });
    await Promise.all([voidResets(ctx, user._id), voidResets(ctx, viewer.id)]);

    return ok;
  },
} satisfies Partial<MutationHandlers>;
