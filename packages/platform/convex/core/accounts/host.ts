import { v } from "convex/values";

import { assignableRole } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalAction, internalMutation } from "../../_generated/server";
import type { DatabaseReader } from "../../_generated/server";
import { fail } from "../lib/errors";
import { hashNewPassword } from "../lib/passwords";
import { parseUsername } from "../lib/usernames";
import { resetPassword as storeResetPassword } from "./resetLinks";
import { DEFAULT_ROLE, insertUser, ownerOf } from "./users";

export const insert = internalMutation({
  args: { username: v.string(), hash: v.string(), role: assignableRole },
  returns: v.id("users"),
  handler: async (ctx, user) => (await insertUser(ctx, user))._id,
});

export const createUser = internalAction({
  args: { username: v.string(), password: v.string(), role: v.optional(assignableRole) },
  returns: v.id("users"),
  handler: async (ctx, { username, password, role }): Promise<Id<"users">> =>
    ctx.runMutation(internal.core.accounts.host.insert, {
      username,
      hash: await hashNewPassword(password),
      role: role ?? DEFAULT_ROLE,
    }),
});

const userNamed = async (db: DatabaseReader, typed: string) => {
  const parsed = parseUsername(typed);

  return parsed === null
    ? null
    : db
        .query("users")
        .withIndex("by_username_key", (q) => q.eq("usernameKey", parsed.usernameKey))
        .unique();
};

export const storeReset = internalMutation({
  args: { username: v.union(v.string(), v.null()), hash: v.string() },
  returns: v.object({ username: v.string() }),
  handler: async (ctx, { username, hash }) => {
    const user = username === null ? await ownerOf(ctx.db) : await userNamed(ctx.db, username);

    if (user === null) {
      return fail("not_found", username === null ? "No owner yet" : `No user ${username}`);
    }

    return { username: (await storeResetPassword(ctx, user, hash)).username };
  },
});

export const resetPassword = internalAction({
  args: { username: v.optional(v.string()), password: v.string() },
  returns: v.object({ username: v.string() }),
  handler: async (ctx, { username, password }): Promise<{ readonly username: string }> =>
    ctx.runMutation(internal.core.accounts.host.storeReset, {
      username: username ?? null,
      hash: await hashNewPassword(password),
    }),
});
