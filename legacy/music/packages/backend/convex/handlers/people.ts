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
import {
  endHostedJam,
  findOwner,
  removeAccount,
  revokeLapsedInvites,
  voidResets,
} from "../lib/people";
import { findSession } from "../lib/playback";
import { contributorOf } from "../lib/present";
import { endUserSessions } from "../lib/sessions";
import { listensBeyond, loadPerson, roleOf } from "../lib/viewer";
import type { Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

/**
 * People `people.directory` reads at most. A server is a household or a small group; this bounds a
 * query any member can run, and a server past it lists its first accounts.
 */
const DIRECTORY_LIMIT = 1000;

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
  joinedViaJam: doc.joinedViaJam !== undefined,
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

  // Names and roles only: sharing a playlist with someone should not show members each other's
  // email addresses.
  "people.directory": async (ctx, viewer) => {
    const users = await ctx.db.query("users").take(DIRECTORY_LIMIT);

    return users
      .filter((user) => user._id !== viewer.id && user.suspendedAt === undefined)
      .map((user) => ({ id: user._id, name: contributorOf(user).name, role: roleOf(user) }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
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
      // Guests can't host a Jam, whose link can make accounts: theirs ends, with its guests, as
      // on suspension or removal.
      await endHostedJam(ctx, user._id);
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
    // A Jam they host ends now, rather than when the cron next notices, and its guests go.
    await endHostedJam(ctx, user._id);

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

    await removeAccount(ctx, user, heir);

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
