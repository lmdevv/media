import { v } from "convex/values";
import type { Infer } from "convex/values";

import { register } from "../../../commands/core/devices/deviceGrants";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { callerUser, requireCaller } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import { requireDeviceName } from "../lib/names";
import { PAGE_ROWS_MAX, paginateAtMost } from "../lib/paginate";
import { takeAttempt } from "../lib/rateLimit";
import {
  constantTimeEqual,
  formatSecret,
  randomSecret,
  parseSecret,
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

/** Deletes a grant and ends every session it issued or minted, in one transaction. */
const revokeGrant = async (
  ctx: Pick<MutationCtx, "db">,
  grantId: Id<"deviceGrants">,
): Promise<void> => {
  await endGrantSessions(ctx, grantId);
  await ctx.db.delete(grantId);
};

/** The grant a device holds, as its row id and the SHA-256 of its secret; never the code itself. */
const heldGrantArgs = v.union(v.null(), v.object({ grantId: v.string(), secretHash: v.string() }));

/**
 * What `place` takes. The action parses and hashes the device's stored code, so no mutation
 * argument carries a bearer secret.
 */
export const placeArgs = v.object({
  held: heldGrantArgs,
  secretHash: v.string(),
  name: v.string(),
});

/** The grant row a device holds, when its secret matches; null otherwise. */
const heldGrant = async (
  db: DatabaseReader,
  held: Infer<typeof heldGrantArgs>,
): Promise<Doc<"deviceGrants"> | null> => {
  const id = held === null ? null : db.normalizeId("deviceGrants", held.grantId);
  const grant = id === null ? null : await db.get(id);

  return held !== null && grant !== null && constantTimeEqual(grant.secretHash, held.secretHash)
    ? grant
    : null;
};

/**
 * Gives the device the caller's grant. When the grant the device holds is the caller's own, it is
 * confirmed: the password the caller just signed in with makes it mint sessions again, as after
 * signing out everywhere. When it is another person's, that grant is revoked first, ending every
 * session it issued or minted, since a phone holds one person (D64). Otherwise, as for a tampered,
 * unknown, or revoked code, the caller gets a new grant and nothing else changes. The last two
 * answer alike, so the answer never tells whose grant the device held. The hourly limit comes
 * before the revoke, so a refused issue revokes nothing.
 */
export const place = internalMutation({
  args: placeArgs,
  returns: v.object({ grantId: v.id("deviceGrants"), kept: v.boolean() }),
  handler: async (ctx, { held, secretHash, name }) => {
    const { caller, person } = await issuer(ctx);
    const deviceName = requireDeviceName(name);
    const grant = await heldGrant(ctx.db, held);

    if (grant !== null && grant.userId === person._id) {
      await ctx.db.patch(grant._id, { name: deviceName, generation: person.sessionGeneration });
      await joinGrant(ctx, caller, grant._id);

      return { grantId: grant._id, kept: true };
    }

    const limit = { identifier: `deviceGrants:${person._id}`, perHour: ISSUES_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, Date.now()))) {
      return fail("rate_limited", "Too many device grants issued; try again in a few minutes");
    }

    if (grant !== null) await revokeGrant(ctx, grant._id);

    const grantId = await ctx.db.insert("deviceGrants", {
      userId: person._id,
      name: deviceName,
      secretHash,
      generation: person.sessionGeneration,
    });

    await joinGrant(ctx, caller, grantId);

    return { grantId, kept: false };
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
    requireDeviceName(name);

    const stored = grant?.trim() ?? null;
    const parsed = stored === null ? null : parseSecret(GRANT_PREFIX, stored);
    const secret = randomSecret(32);

    const placed: { readonly grantId: Id<"deviceGrants">; readonly kept: boolean } =
      await ctx.runMutation(internal.core.devices.deviceGrants.place, {
        held:
          parsed === null
            ? null
            : { grantId: parsed.rowId, secretHash: await sha256Hex(parsed.secret) },
        secretHash: await sha256Hex(secret),
        name,
      });

    return {
      grantId: placed.grantId,
      grant:
        placed.kept && stored !== null
          ? stored
          : formatSecret(GRANT_PREFIX, placed.grantId, secret),
    };
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

    await revokeGrant(ctx, grant._id);

    return null;
  },
});
