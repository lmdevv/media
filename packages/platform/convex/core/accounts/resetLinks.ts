import { v } from "convex/values";

import { register } from "../../../commands/core/accounts/resetLinks";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { callerUser, refuseKeys, requireCaller } from "../auth/caller";
import { fail } from "../lib/errors";
import { signInLimit, storePassword } from "../lib/passwords";
import { clearAttempts } from "../lib/rateLimit";
import { formatSecret, randomSecret, rowForSecret, sha256Hex } from "../lib/secrets";
import { requireAccount } from "../permissions/authorize";
import { accountTarget, can, principalOf } from "../permissions/policy";
import type { PersonDoc } from "../permissions/policy";
import { endUserCredentials, openSession, signedIn } from "../sessions";
import { asPerson } from "./users";

const PREFIX = "mr";

const LINK_MS = 24 * 60 * 60 * 1000;

const DEAD = "This reset link no longer works; ask an admin for a new one";

interface OpenLink {
  readonly link: Doc<"resetLinks">;
  readonly user: PersonDoc;
}

const openLinkFor = async (db: DatabaseReader, code: string, now: number): Promise<OpenLink> => {
  const link = await rowForSecret(PREFIX, code, async (rowId) => {
    const id = db.normalizeId("resetLinks", rowId);

    return id === null ? null : db.get(id);
  });

  if (link === null || link.expiresAt <= now) return fail("expired", DEAD);

  const [found, maker] = await Promise.all([db.get(link.userId), db.get(link.madeBy)]);
  const user = asPerson(found);

  return user !== null &&
    maker !== null &&
    user.sessionGeneration === link.userSessionGeneration &&
    maker.sessionGeneration === link.makerSessionGeneration &&
    can(principalOf(maker), "resetPassword", accountTarget(user)).allowed
    ? { link, user }
    : fail("expired", DEAD);
};

export const resetPassword = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  user: PersonDoc,
  hash: string,
): Promise<PersonDoc> => {
  await storePassword(ctx.db, user._id, hash);
  await endUserCredentials(ctx, user);
  await clearAttempts(ctx, signInLimit(user.usernameKey));

  return asPerson(await ctx.db.get(user._id)) ?? fail("not_found", "No such user");
};

export const insert = internalMutation({
  args: { userId: v.id("users"), secretHash: v.string() },
  returns: v.object({ resetLinkId: v.id("resetLinks"), expiresAt: v.number() }),
  handler: async (ctx, { userId, secretHash }) => {
    const caller = refuseKeys(await requireCaller(ctx, "admin"));
    const maker = await callerUser(ctx, caller);
    const user = await requireAccount(ctx, caller, "resetPassword", userId);

    const expiresAt = Date.now() + LINK_MS;

    const resetLinkId = await ctx.db.insert("resetLinks", {
      secretHash,
      userId,
      madeBy: caller.userId,
      userSessionGeneration: user.sessionGeneration,
      makerSessionGeneration: maker.sessionGeneration,
      expiresAt,
    });

    return { resetLinkId, expiresAt };
  },
});

export const redeem = internalMutation({
  args: { code: v.string(), hash: v.string() },
  returns: signedIn,
  handler: async (ctx, { code, hash }) => {
    const now = Date.now();
    const { link, user } = await openLinkFor(ctx.db, code, now);

    await ctx.db.delete(link._id);

    const reset = await resetPassword(ctx, user, hash);

    return {
      userId: reset._id,
      sessionId: await openSession(ctx, reset, { kind: "password" }, now),
    };
  },
});

export const { create, lookup } = register({
  create: async (ctx, { userId }) => {
    const secret = randomSecret(32);

    const { resetLinkId, expiresAt } = await ctx.runMutation(
      internal.core.accounts.resetLinks.insert,
      { userId, secretHash: await sha256Hex(secret) },
    );

    return { code: formatSecret(PREFIX, resetLinkId, secret), expiresAt };
  },
  lookup: async (ctx, { code }) => {
    const { link, user } = await openLinkFor(ctx.db, code, Date.now());

    return { username: user.username, expiresAt: link.expiresAt };
  },
});
