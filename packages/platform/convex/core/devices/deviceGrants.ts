import { v } from "convex/values";

import { register } from "../../../commands/core/devices/deviceGrants";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { callerUser, requireCaller } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import { GIVEN_NAME_MAX, requireGivenName } from "../lib/names";
import { PAGE_ROWS_MAX, paginateAtMost } from "../lib/paginate";
import { takeAttempt } from "../lib/rateLimit";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { LIST_CALL_READS } from "../permissions/grants";
import { can } from "../permissions/policy";
import type { Because, GrantAction, PersonDoc } from "../permissions/policy";
import {
  GRANT_SESSIONS_MAX,
  boundDevice,
  endGrantSessions,
  grantSessions,
  liveOnDevice,
  openSession,
  signedIn,
  trimGrantSessions,
} from "../sessions";

/** A device grant reads `dg_<grantId>.<secret>`. */
export const GRANT_PREFIX = "dg";

const ISSUES_PER_HOUR = 20;

/** One answer for every grant that does not sign in, so a refusal tells nothing about the grant. */
export const BAD_GRANT = "This device grant does not work; sign in with your password";

const NO_GRANT = "No such device grant";

/** What a listed grant costs: its row, and each of its sessions with the device it is on. */
const LIST_ROW_READS = 1 + 2 * GRANT_SESSIONS_MAX;

const LIST_ROWS = Math.floor((PAGE_ROWS_MAX - LIST_CALL_READS) / LIST_ROW_READS);

const parseName = (name: string): string =>
  requireGivenName(name, `Name the device with 1 to ${GIVEN_NAME_MAX} printable characters`);

const refusal = (action: GrantAction, because: Because): string => {
  if (because === "scope") return "Only your own account session can do this";

  if (because === "guest") return "A guest has no device grants";

  if (because === "api-key") return "API keys cannot do this; sign in with a password";

  return action === "issue" && because === "needs-password"
    ? "Only a password sign-in issues a device grant"
    : NO_GRANT;
};

/** Decides `action` on a grant `owner` holds for `caller`; a refusal fails and says why. */
const requireGrantAction = (caller: Caller, action: GrantAction, owner: Id<"users">): void => {
  const decision = can(caller, action, { on: "deviceGrant", owner });

  if (decision.allowed) return;

  if (decision.refusal === "hidden") return fail("not_found", NO_GRANT);

  return fail("forbidden", refusal(action, decision.because));
};

/**
 * Whether a grant still mints sessions: since it was issued or last confirmed, its person has not
 * signed out everywhere or changed their password, no one reset it, and no role change took a
 * scope from them.
 */
const signsIn = (grant: Doc<"deviceGrants">, user: Doc<"users">): boolean =>
  user.kind === "person" &&
  user.role !== "guest" &&
  grant.userId === user._id &&
  grant.generation === user.sessionGeneration;

/** Exchanges a grant for a new session of its person; null when the grant does not sign in. */
export const redeem = internalMutation({
  args: { userId: v.string(), grantId: v.string(), secretHash: v.string() },
  returns: v.union(v.null(), signedIn),
  handler: async (ctx, { userId, grantId, secretHash }) => {
    const id = ctx.db.normalizeId("deviceGrants", grantId);
    const grant = id === null ? null : await ctx.db.get(id);

    if (
      grant === null ||
      !constantTimeEqual(grant.secretHash, secretHash) ||
      grant.userId !== userId
    ) {
      return null;
    }

    const user = await ctx.db.get(grant.userId);

    if (user === null || !signsIn(grant, user)) return null;

    return {
      userId: user._id,
      sessionId: await openSession(ctx, user, { kind: "grant", grant }, Date.now()),
    };
  },
});

/** The caller's person, once `can` lets them issue a grant. */
const issuer = async (
  ctx: Pick<MutationCtx, "auth" | "db">,
): Promise<{ readonly caller: Caller; readonly person: PersonDoc }> => {
  const caller = await requireCaller(ctx, "account");

  requireGrantAction(caller, "issue", caller.userId);

  return { caller, person: await callerUser(ctx, caller) };
};

/** Puts the caller's password session in the grant's family, so revoking the grant ends it too. */
const joinGrant = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  caller: Caller,
  grantId: Id<"deviceGrants">,
): Promise<void> => {
  await ctx.db.patch(caller.sessionId, { grant: grantId });
  await trimGrantSessions(ctx, grantId, caller.sessionId);
};

/**
 * Confirms the grant the device keeps when it is the caller's own: the password the caller just
 * signed in with makes it mint sessions again, as after signing out everywhere. Null when the
 * code names no grant of the caller's, so the device gets a new one.
 */
export const confirm = internalMutation({
  args: { grantId: v.string(), secretHash: v.string(), name: v.string() },
  returns: v.union(v.id("deviceGrants"), v.null()),
  handler: async (ctx, { grantId, secretHash, name }) => {
    const { caller, person } = await issuer(ctx);
    const id = ctx.db.normalizeId("deviceGrants", grantId);
    const grant = id === null ? null : await ctx.db.get(id);

    if (
      grant === null ||
      grant.userId !== person._id ||
      !constantTimeEqual(grant.secretHash, secretHash)
    ) {
      return null;
    }

    await ctx.db.patch(grant._id, { name: parseName(name), generation: person.sessionGeneration });
    await joinGrant(ctx, caller, grant._id);

    return grant._id;
  },
});

/** Stores a new grant for the caller and puts the caller's session in its family. */
export const insert = internalMutation({
  args: { secretHash: v.string(), name: v.string() },
  returns: v.id("deviceGrants"),
  handler: async (ctx, { secretHash, name }) => {
    const { caller, person } = await issuer(ctx);
    const limit = { identifier: `deviceGrants:${person._id}`, perHour: ISSUES_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, Date.now()))) {
      return fail("rate_limited", "Too many device grants issued; try again in a few minutes");
    }

    const grantId = await ctx.db.insert("deviceGrants", {
      userId: person._id,
      name: parseName(name),
      secretHash,
      generation: person.sessionGeneration,
    });

    await joinGrant(ctx, caller, grantId);

    return grantId;
  },
});

const devicesOf = async (
  db: DatabaseReader,
  grant: Doc<"deviceGrants">,
  user: Doc<"users">,
  now: number,
): Promise<ReadonlyArray<{ readonly deviceId: Id<"devices">; readonly name: string }>> => {
  const sessions = await grantSessions(db, grant._id).take(GRANT_SESSIONS_MAX);

  const devices = await Promise.all(
    sessions.map(async (session) => {
      const bound = boundDevice(session);
      const device = bound === null ? null : await db.get(bound.id);

      return device !== null && liveOnDevice(session, user, device, now)
        ? [{ deviceId: device._id, name: device.name }]
        : [];
    }),
  );

  return devices.flat();
};

export const { issue, list, revoke } = register({
  issue: async (ctx, { name, grant }) => {
    parseName(name);

    const stored = grant?.trim();
    const parsed = stored === undefined ? null : parseSecret(GRANT_PREFIX, stored);

    if (stored !== undefined && parsed !== null) {
      const confirmed: Id<"deviceGrants"> | null = await ctx.runMutation(
        internal.core.devices.deviceGrants.confirm,
        { grantId: parsed.rowId, secretHash: await sha256Hex(parsed.secret), name },
      );

      if (confirmed !== null) return { grantId: confirmed, grant: stored };
    }

    const secret = randomSecret(32);

    const grantId: Id<"deviceGrants"> = await ctx.runMutation(
      internal.core.devices.deviceGrants.insert,
      { secretHash: await sha256Hex(secret), name },
    );

    return { grantId, grant: formatSecret(GRANT_PREFIX, grantId, secret) };
  },
  list: async (ctx, { paginationOpts }, caller) => {
    requireGrantAction(caller, "list", caller.userId);

    const user = await callerUser(ctx, caller);
    const now = Date.now();

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "deviceGrants",
        index: "by_user",
        range: (q) => q.eq("userId", user._id),
        order: "desc",
      },
      paginationOpts,
      LIST_ROWS,
    );

    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (grant) => ({
          grantId: grant._id,
          name: grant.name,
          issuedAt: grant._creationTime,
          signsIn: signsIn(grant, user),
          devices: [...(await devicesOf(ctx.db, grant, user, now))],
        })),
      ),
    };
  },
  revoke: async (ctx, { grantId }, caller) => {
    const grant = (await ctx.db.get(grantId)) ?? fail("not_found", NO_GRANT);

    requireGrantAction(caller, "revoke", grant.userId);

    await endGrantSessions(ctx, grant._id);
    await ctx.db.delete(grant._id);

    return null;
  },
});
