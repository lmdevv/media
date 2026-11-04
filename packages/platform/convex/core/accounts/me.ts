import { v } from "convex/values";

import { register } from "../../../commands/core/accounts/me";
import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { requireCaller } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import {
  checkNewPassword,
  hashNewPassword,
  passwordHashOf,
  passwordMatches,
  signInLimit,
  storePassword,
} from "../lib/passwords";
import { refundAttempt, takeAttempt } from "../lib/rateLimit";
import { endUserSessions } from "../sessions";
import { renameUser } from "./users";

const callerUser = async (ctx: Pick<MutationCtx, "db">, caller: Caller) =>
  (await ctx.db.get(caller.userId)) ?? fail("unauthenticated", "Sign in first");

export const attempt = internalMutation({
  args: {},
  returns: v.union(
    v.object({ kind: v.literal("limited") }),
    v.object({ kind: v.literal("known"), hash: v.string() }),
  ),
  handler: async (ctx) => {
    const user = await callerUser(ctx, await requireCaller(ctx, "account"));

    if (!(await takeAttempt(ctx, signInLimit(user.usernameKey), Date.now()))) {
      return { kind: "limited" as const };
    }

    const hash =
      (await passwordHashOf(ctx.db, user._id)) ?? fail("unauthenticated", "Sign in first");

    return { kind: "known" as const, hash };
  },
});

export const replace = internalMutation({
  args: { checkedHash: v.string(), hash: v.string() },
  returns: v.null(),
  handler: async (ctx, { checkedHash, hash }) => {
    const caller = await requireCaller(ctx, "account");
    const user = await callerUser(ctx, caller);

    if ((await passwordHashOf(ctx.db, user._id)) !== checkedHash) {
      return fail("conflict", "Your password changed meanwhile; try again");
    }

    await storePassword(ctx.db, user._id, hash);
    await refundAttempt(ctx, signInLimit(user.usernameKey), Date.now());
    await endUserSessions(ctx, user, caller.sessionId);

    return null;
  },
});

export const { rename, changePassword } = register({
  rename: async (ctx, { username }, caller) => {
    await renameUser(ctx, await callerUser(ctx, caller), username);

    return null;
  },
  changePassword: async (ctx, { currentPassword, newPassword }) => {
    checkNewPassword(newPassword);

    const attempted = await ctx.runMutation(internal.core.accounts.me.attempt, {});

    if (attempted.kind === "limited") {
      return fail("rate_limited", "Too many password tries; wait a few minutes and try again");
    }

    if (!(await passwordMatches(attempted.hash, currentPassword))) {
      return fail("unauthenticated", "Wrong password");
    }

    await ctx.runMutation(internal.core.accounts.me.replace, {
      checkedHash: attempted.hash,
      hash: await hashNewPassword(newPassword),
    });

    return null;
  },
});
