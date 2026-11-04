import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";
import { Scrypt } from "lucia";

import { internal } from "../../_generated/api";
import type { DataModel, Id } from "../../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { refundAttempt, takeAttempt } from "../lib/rateLimit";
import type { RateLimit } from "../lib/rateLimit";
import { parseUsername } from "../lib/usernames";
import { openSession } from "../sessions";
import type { SignedIn } from "../sessions";

/**
 * Convex Auth's own password accounts are not used: its `retrieveAccount` does not limit unknown
 * usernames, and its `createAccount` signs an existing account in with no limit at all.
 */

const PROVIDER = "password";

const PASSWORD_MIN = 8;

const PASSWORD_MAX = 256;

const SIGN_INS_PER_HOUR = 10;

const WRONG = "Wrong username or password";

const scrypt = new Scrypt();

const UNKNOWN_USERNAME_HASH =
  "9b85878bab07975235c82ca16d4a436e:0e1a61cd72f6f24ec60a72c2c52b1ec4d79462d0ddb8aace2393cf133f297751fad1d7522d5d45a61502e21540c850defcb7f1e39304ee99dd31964fa2a56c8d";

const signInLimit = (usernameKey: string): RateLimit => ({
  identifier: `${PROVIDER}:${usernameKey}`,
  perHour: SIGN_INS_PER_HOUR,
});

const credentials = { username: v.string(), password: v.string() };

const parseCredentials = makeFunctionReference<
  "query",
  Partial<Record<string, Value | undefined>>,
  { readonly username: string; readonly password: string }
>("core/auth/password:parse");

/** Checks the sign-in params' shape. */
export const parse = internalQuery({
  args: credentials,
  returns: v.object(credentials),
  handler: (_ctx, args) => args,
});

/**
 * The password provider. Refuses with `invalid_args` for malformed params or an overlong password,
 * `rate_limited` once the username's bucket is empty, and one `unauthenticated` message otherwise.
 */
export const passwordProvider = ConvexCredentials<DataModel>({
  id: PROVIDER,
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { username, password } = await ctx.runQuery(parseCredentials, params);

    if (password.length > PASSWORD_MAX) {
      return fail("invalid_args", `Use at most ${PASSWORD_MAX} characters for the password`);
    }

    const parsed = parseUsername(username);

    if (parsed === null) return fail("unauthenticated", WRONG);

    const attempted = await ctx.runMutation(internal.core.auth.password.attempt, {
      usernameKey: parsed.usernameKey,
    });

    if (attempted.kind === "limited") {
      return fail("rate_limited", "Too many sign-in attempts; wait a few minutes and try again");
    }

    const matches = await scrypt.verify(
      attempted.kind === "known" ? attempted.hash : UNKNOWN_USERNAME_HASH,
      password,
    );

    if (attempted.kind !== "known" || !matches) return fail("unauthenticated", WRONG);

    const opened = await ctx.runMutation(internal.core.auth.password.open, {
      userId: attempted.userId,
      hash: attempted.hash,
      usernameKey: parsed.usernameKey,
    });

    return opened ?? fail("unauthenticated", WRONG);
  },
});

const passwordOf = async (
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
): Promise<string | undefined> =>
  (
    await ctx.db
      .query("passwords")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique()
  )?.hash;

/** Takes a sign-in try, then finds the user and their password hash. */
export const attempt = internalMutation({
  args: { usernameKey: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("limited") }),
    v.object({ kind: v.literal("unknown") }),
    v.object({ kind: v.literal("known"), userId: v.id("users"), hash: v.string() }),
  ),
  handler: async (ctx, { usernameKey }) => {
    if (!(await takeAttempt(ctx, signInLimit(usernameKey), Date.now()))) {
      return { kind: "limited" as const };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_username_key", (q) => q.eq("usernameKey", usernameKey))
      .unique();

    const hash = user === null ? undefined : await passwordOf(ctx, user._id);

    return user === null || hash === undefined
      ? { kind: "unknown" as const }
      : { kind: "known" as const, userId: user._id, hash };
  },
});

/** Opens a password session; null when the password or the user changed since `attempt`. */
export const open = internalMutation({
  args: { userId: v.id("users"), hash: v.string(), usernameKey: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), sessionId: v.id("authSessions") })),
  handler: async (ctx, { userId, hash, usernameKey }) => {
    const user = await ctx.db.get(userId);

    if (
      user === null ||
      user.usernameKey !== usernameKey ||
      (await passwordOf(ctx, userId)) !== hash
    ) {
      return null;
    }

    const now = Date.now();

    await refundAttempt(ctx, signInLimit(usernameKey), now);

    return { userId, sessionId: await openSession(ctx, user, { kind: "password" }, now) };
  },
});

const insertUser = async (
  ctx: Pick<MutationCtx, "db">,
  typed: string,
  hash: string,
): Promise<Id<"users">> => {
  const parsed =
    parseUsername(typed) ??
    fail(
      "invalid_args",
      "Use 1 to 32 letters, digits, dots, dashes, or underscores, starting with a letter or digit",
    );

  const taken = await ctx.db
    .query("users")
    .withIndex("by_username_key", (q) => q.eq("usernameKey", parsed.usernameKey))
    .first();

  if (taken !== null) return fail("conflict", "That username is taken");

  const userId = await ctx.db.insert("users", {
    ...parsed,
    sessionGeneration: 0,
    keyGeneration: 0,
  });

  await ctx.db.insert("passwords", { userId, hash });

  return userId;
};

/** `insertUser` for `createUser`. */
export const insert = internalMutation({
  args: { username: v.string(), hash: v.string() },
  returns: v.id("users"),
  handler: (ctx, { username, hash }) => insertUser(ctx, username, hash),
});

/** Creates a user with a username and a password. */
export const createUser = internalAction({
  args: { username: v.string(), password: v.string() },
  returns: v.id("users"),
  handler: async (ctx, { username, password }): Promise<Id<"users">> => {
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return fail(
        "invalid_args",
        `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters for the password`,
      );
    }

    return ctx.runMutation(internal.core.auth.password.insert, {
      username,
      hash: await scrypt.hash(password),
    });
  },
});
