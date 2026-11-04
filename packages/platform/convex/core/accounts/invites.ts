import { v } from "convex/values";

import { register } from "../../../commands/core/accounts/invites";
import { assignableRole } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import { fail } from "../lib/errors";
import { paginate } from "../lib/paginate";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { openSession, roleHolds, signedIn } from "../sessions";
import { insertUser } from "./users";

const PREFIX = "mi";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DAYS = 7;

const DAYS_MAX = 30;

const DEAD = "This invite no longer works; ask an admin for a new one";

interface OpenInvite {
  readonly invite: Doc<"invites">;
  readonly invitedBy: Doc<"users">;
}

const openInvite = async (
  db: DatabaseReader,
  inviteId: string,
  secretHash: string,
  now: number,
): Promise<OpenInvite | null> => {
  const id = db.normalizeId("invites", inviteId);
  const invite = id === null ? null : await db.get(id);

  if (invite === null || !constantTimeEqual(invite.secretHash, secretHash)) return null;

  const invitedBy = await db.get(invite.invitedBy);

  return invite.expiresAt > now && invitedBy !== null && roleHolds(invitedBy.role, "admin")
    ? { invite, invitedBy }
    : null;
};

const openInviteFor = async (db: DatabaseReader, code: string, now: number) => {
  const parsed = parseSecret(PREFIX, code.trim());

  const found =
    parsed === null
      ? null
      : await openInvite(db, parsed.rowId, await sha256Hex(parsed.secret), now);

  return found ?? fail("expired", DEAD);
};

export const insert = internalMutation({
  args: { secretHash: v.string(), role: assignableRole, expiresInDays: v.number() },
  returns: v.object({ inviteId: v.id("invites"), expiresAt: v.number() }),
  handler: async (ctx, { secretHash, role, expiresInDays }) => {
    const caller = refuseKeys(await requireCaller(ctx, "admin"));

    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > DAYS_MAX) {
      return fail("invalid_args", `Invites last 1 to ${DAYS_MAX} days`);
    }

    const expiresAt = Date.now() + expiresInDays * DAY_MS;

    const inviteId = await ctx.db.insert("invites", {
      secretHash,
      role,
      invitedBy: caller.userId,
      expiresAt,
    });

    return { inviteId, expiresAt };
  },
});

export const accept = internalMutation({
  args: { code: v.string(), username: v.string(), hash: v.string() },
  returns: signedIn,
  handler: async (ctx, { code, username, hash }) => {
    const now = Date.now();
    const found = await openInviteFor(ctx.db, code, now);
    const user = await insertUser(ctx, { username, hash, role: found.invite.role });

    await ctx.db.delete(found.invite._id);

    return { userId: user._id, sessionId: await openSession(ctx, user, { kind: "password" }, now) };
  },
});

export const { create, lookup, list, revoke } = register({
  create: async (ctx, { role, expiresInDays }) => {
    const secret = randomSecret(32);

    const { inviteId, expiresAt } = await ctx.runMutation(internal.core.accounts.invites.insert, {
      secretHash: await sha256Hex(secret),
      role: role ?? "member",
      expiresInDays: expiresInDays ?? DEFAULT_DAYS,
    });

    return { inviteId, code: formatSecret(PREFIX, inviteId, secret), expiresAt };
  },
  lookup: async (ctx, { code }) => {
    const { invite, invitedBy } = await openInviteFor(ctx.db, code, Date.now());

    return { role: invite.role, invitedBy: invitedBy.username, expiresAt: invite.expiresAt };
  },
  list: async (ctx, { paginationOpts }) => {
    const now = Date.now();

    const page = await paginate(
      ctx.db,
      { table: "invites", index: "by_expiration", range: (q) => q.gt("expiresAt", now) },
      paginationOpts,
    );

    const makers = new Map(
      await Promise.all(
        [...new Set(page.page.map((invite) => invite.invitedBy))].map(
          async (userId) => [userId, (await ctx.db.get(userId))?.username ?? ""] as const,
        ),
      ),
    );

    return {
      ...page,
      page: page.page.map((invite) => ({
        inviteId: invite._id,
        role: invite.role,
        invitedBy: makers.get(invite.invitedBy) ?? "",
        expiresAt: invite.expiresAt,
      })),
    };
  },
  revoke: async (ctx, { inviteId }) => {
    if ((await ctx.db.get(inviteId)) === null) return fail("not_found", "No such invite");

    await ctx.db.delete(inviteId);

    return null;
  },
});
