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
import { DEFAULT_ROLE, asPerson, insertUser, ownerOf } from "./users";

const SERVICE_NAME_MAX = 64;

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

/**
 * Creates a service principal, such as the media server: a user with no role, password, or
 * restrictions, which no admin can give a role.
 */
export const createService = internalMutation({
  args: { name: v.string() },
  returns: v.id("users"),
  handler: async (ctx, { name }) => {
    const trimmed = name.trim();

    if (trimmed.length === 0 || trimmed.length > SERVICE_NAME_MAX) {
      return fail("invalid_args", `Name a service with 1 to ${SERVICE_NAME_MAX} characters`);
    }

    return ctx.db.insert("users", {
      kind: "service",
      name: trimmed,
      sessionGeneration: 0,
      keyGeneration: 0,
    });
  },
});

const userNamed = async (db: DatabaseReader, typed: string) => {
  const parsed = parseUsername(typed);

  return parsed === null
    ? null
    : asPerson(
        await db
          .query("users")
          .withIndex("by_username_key", (q) => q.eq("usernameKey", parsed.usernameKey))
          .unique(),
      );
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
