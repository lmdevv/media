/**
 * Password reset without email. Self-hosted servers rarely send mail, so an admin creates a
 * one-time link (`people.reset`) and hands it over; the `reset` flow of the password provider in
 * `auth.ts` redeems it. An operator locked out of the owner account can make one with the admin
 * key: `convex run passwordResets:createForEmail '{"email": "you@example.com"}'`.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { createPasswordReset } from "./handlers/people";
import { fail } from "./lib/errors";
import { resetByHash, resetStillAllowed } from "./lib/resets";
import { endUserSessions, openSession } from "./lib/sessions";
import { SUSPENDED_MESSAGE } from "./lib/viewer";

/**
 * Redeems the reset link with this token hash, in one transaction: checks the link and that its
 * maker may still reset the person, sets `secret` (the new password's hash) on the person's own
 * password account, found by their ID rather than by the email, uses the link up, and ends every
 * session they had, and turns off every API key they had. Returns the person, or fails saying why
 * the link does not work. Nothing that
 * changes who may reset them can land between the check and the new password.
 */
export const redeem = internalMutation({
  args: { hash: v.string(), provider: v.string(), secret: v.string() },
  handler: async (ctx, { hash, provider, secret }) => {
    const reset = await resetByHash(ctx, hash);

    if (reset === null) return fail("invalid_args", "This reset link is not valid");

    if (reset.usedAt !== undefined) {
      return fail("invalid_args", "This reset link was already used");
    }

    if (reset.expiresAt < Date.now()) return fail("invalid_args", "This reset link has expired");
    const user = await ctx.db.get(reset.userId);

    if (user === null) return fail("invalid_args", "This reset link is not valid");

    if (user.suspendedAt !== undefined) return fail("forbidden", SUSPENDED_MESSAGE);

    if (!(await resetStillAllowed(ctx, reset, user))) {
      return fail("invalid_args", "This reset link is no longer valid; ask an admin for a new one");
    }

    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id).eq("provider", provider))
      .unique();

    if (account === null) return fail("invalid_args", "This account has no password to reset");

    await ctx.db.patch(account._id, { secret });
    await ctx.db.patch(reset._id, { usedAt: Date.now() });

    // Whoever had the account may have made API keys: every key made so far stops at once, with
    // the sessions it opened (`keysValidAfter`); the rows are revoked in batches. Keys made
    // after this work.
    await ctx.db.patch(user._id, { keysValidAfter: Date.now() });
    await ctx.scheduler.runAfter(0, internal.people.revokeKeys, { userId: user._id, cursor: null });

    // Every session ends, and the one the reset signs in with opens in the new generation, here,
    // so it is the only one left.
    const generation = await endUserSessions(ctx, user._id);
    const sessionId = await openSession(ctx, user, generation);

    return { userId: user._id, sessionId };
  },
});

/** Makes a reset link for the account with `email`, for operators with the admin key. */
export const createForEmail = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.trim().toLowerCase()))
      .unique();

    if (user === null) return fail("not_found", `No account with email ${email}`);

    const { token, expiresAt } = await createPasswordReset(ctx, user._id, undefined);

    return { path: `/reset/${token}`, expiresAt: new Date(expiresAt).toISOString() };
  },
});
