import { v } from "convex/values";

import { register } from "../../../commands/core/accounts/users";
import { assignableRole } from "../../../commands/scopes";
import type { AssignableRole, Role } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import { fail } from "../lib/errors";
import { paginate } from "../lib/paginate";
import { hashNewPassword, storePassword } from "../lib/passwords";
import { requireUsername } from "../lib/usernames";
import { requireAccount } from "../permissions/authorize";
import { endsCredentials } from "../permissions/policy";
import type { PersonDoc } from "../permissions/policy";
import { endUserCredentials, openSession, signedIn } from "../sessions";

export const DEFAULT_ROLE: AssignableRole = "member";

/** A user row as a person, or null for a service or nobody. */
export const asPerson = (user: Doc<"users"> | null): PersonDoc | null =>
  user?.kind === "person" ? user : null;

export const ownerOf = async (db: DatabaseReader): Promise<PersonDoc | null> =>
  asPerson(
    await db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "owner"))
      .unique(),
  );

const refuseTakenKey = async (db: DatabaseReader, usernameKey: string): Promise<void> => {
  const taken = await db
    .query("users")
    .withIndex("by_username_key", (q) => q.eq("usernameKey", usernameKey))
    .first();

  if (taken !== null) fail("conflict", "That username is taken");
};

export const insertUser = async (
  ctx: Pick<MutationCtx, "db">,
  user: { readonly username: string; readonly hash: string; readonly role: Role },
): Promise<PersonDoc> => {
  const parsed = requireUsername(user.username);
  const hasOwner = (await ownerOf(ctx.db)) !== null;

  if (user.role === "owner" && hasOwner) {
    return fail("conflict", "This server already has an owner; sign in instead");
  }

  if (user.role !== "owner" && !hasOwner) {
    return fail("forbidden", "Set up the server's owner first");
  }

  await refuseTakenKey(ctx.db, parsed.usernameKey);

  const userId = await ctx.db.insert("users", {
    kind: "person",
    ...parsed,
    role: user.role,
    sessionGeneration: 0,
    keyGeneration: 0,
  });

  await storePassword(ctx.db, userId, user.hash);

  return asPerson(await ctx.db.get(userId)) ?? fail("not_found", "The new user vanished");
};

export const renameUser = async (
  ctx: Pick<MutationCtx, "db">,
  user: PersonDoc,
  typed: string,
): Promise<void> => {
  const parsed = requireUsername(typed);

  if (parsed.usernameKey !== user.usernameKey) await refuseTakenKey(ctx.db, parsed.usernameKey);

  await ctx.db.patch(user._id, parsed);
};

export const setUp = internalMutation({
  args: { username: v.string(), hash: v.string() },
  returns: signedIn,
  handler: async (ctx, { username, hash }) => {
    const user = await insertUser(ctx, { username, hash, role: "owner" });

    return {
      userId: user._id,
      sessionId: await openSession(ctx, user, { kind: "password" }, Date.now()),
    };
  },
});

export const insert = internalMutation({
  args: { username: v.string(), hash: v.string(), role: assignableRole },
  returns: v.id("users"),
  handler: async (ctx, { username, hash, role }) => {
    refuseKeys(await requireCaller(ctx, "admin"));

    return (await insertUser(ctx, { username, hash, role }))._id;
  },
});

export const { create, list, setRole, handOverOwnership } = register({
  create: async (ctx, { username, password, role }) => {
    requireUsername(username);

    const userId = await ctx.runMutation(internal.core.accounts.users.insert, {
      username,
      hash: await hashNewPassword(password),
      role: role ?? DEFAULT_ROLE,
    });

    return { userId };
  },
  list: async (ctx, { paginationOpts }) => {
    const page = await paginate(
      ctx.db,
      {
        table: "users",
        index: "by_kind_username_key",
        range: (q) => q.eq("kind", "person"),
      },
      paginationOpts,
    );

    return {
      ...page,
      page: page.page.flatMap((user) =>
        user.kind === "person"
          ? [{ userId: user._id, username: user.username, role: user.role }]
          : [],
      ),
    };
  },
  setRole: async (ctx, { userId, role }, caller) => {
    const target = await requireAccount(ctx, caller, "setRole", userId);

    if (target.role === role) return null;

    await ctx.db.patch(target._id, { role });

    if (endsCredentials(target.role, role)) await endUserCredentials(ctx, target);

    return null;
  },
  handOverOwnership: async (ctx, { userId }, caller) => {
    const target = await requireAccount(ctx, caller, "handOverOwnership", userId);

    await ctx.db.patch(target._id, { role: "owner" });
    await ctx.db.patch(caller.userId, { role: "admin" });

    return null;
  },
});
