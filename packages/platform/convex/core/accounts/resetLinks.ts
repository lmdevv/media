import { v } from "convex/values";

import { register } from "../../../commands/core/accounts/resetLinks";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import { fail } from "../lib/errors";
import { signInLimit, storePassword } from "../lib/passwords";
import { clearAttempts } from "../lib/rateLimit";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { endUserKeys, endUserSessions, openSession, signedIn } from "../sessions";
import { manages } from "./users";

/** A reset link code is `mr_<resetLinkId>.<secret>`. */
const PREFIX = "mr";

const LINK_MS = 24 * 60 * 60 * 1000;

const DEAD = "This reset link no longer works; ask an admin for a new one";

/** A reset link that still works, and the user whose password it sets. */
interface OpenLink {
  readonly link: Doc<"resetLinks">;
  readonly user: Doc<"users">;
}

/**
 * The reset link a code names when its secret matches, it has not expired, the user's sessions
 * have not ended since it was made, and its maker may still manage the user. Refuses every other
 * case alike with `expired`.
 */
const openLinkFor = async (db: DatabaseReader, code: string, now: number): Promise<OpenLink> => {
  const parsed = parseSecret(PREFIX, code.trim());
  const id = parsed === null ? null : db.normalizeId("resetLinks", parsed.rowId);
  const link = id === null ? null : await db.get(id);

  if (
    parsed === null ||
    link === null ||
    !constantTimeEqual(link.secretHash, await sha256Hex(parsed.secret)) ||
    link.expiresAt <= now
  ) {
    return fail("expired", DEAD);
  }

  const [user, maker] = await Promise.all([db.get(link.userId), db.get(link.madeBy)]);

  return user !== null &&
    maker !== null &&
    user.sessionGeneration === link.generation &&
    manages({ userId: maker._id, role: maker.role }, user)
    ? { link, user }
    : fail("expired", DEAD);
};

/**
 * Sets a new password after a reset: ends every session and API key the user had, so whoever
 * else knew the old password is out, and fills their sign-in tries again. Returns the user as
 * stored afterwards.
 */
export const resetPassword = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  user: Doc<"users">,
  hash: string,
): Promise<Doc<"users">> => {
  await storePassword(ctx.db, user._id, hash);
  await endUserSessions(ctx, user);
  await endUserKeys(ctx, user);
  await clearAttempts(ctx, signInLimit(user.usernameKey));

  return (await ctx.db.get(user._id)) ?? fail("not_found", "No such user");
};

/** Stores a new reset link the calling admin made for `userId`. */
export const insert = internalMutation({
  args: { userId: v.id("users"), secretHash: v.string() },
  returns: v.object({ resetLinkId: v.id("resetLinks"), expiresAt: v.number() }),
  handler: async (ctx, { userId, secretHash }) => {
    const caller = refuseKeys(await requireCaller(ctx, "admin"));
    const user = (await ctx.db.get(userId)) ?? fail("not_found", "No such user");

    if (user.role === "owner") {
      return fail("forbidden", "The owner resets their password on the server host");
    }

    if (!manages(caller, user)) {
      return fail("forbidden", "Change your own password from your own settings");
    }

    const expiresAt = Date.now() + LINK_MS;

    const resetLinkId = await ctx.db.insert("resetLinks", {
      secretHash,
      userId,
      madeBy: caller.userId,
      generation: user.sessionGeneration,
      expiresAt,
    });

    return { resetLinkId, expiresAt };
  },
});

/** Sets the password a reset link allows and signs the user in, for the `reset` provider. */
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
