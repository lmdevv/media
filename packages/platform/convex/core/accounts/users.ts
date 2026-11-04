import { v } from "convex/values";

import { register } from "../../../commands/core/accounts/users";
import { assignableRole } from "../../../commands/scopes";
import type { AssignableRole, Role } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import { fail } from "../lib/errors";
import { paginate } from "../lib/paginate";
import { hashNewPassword, storePassword } from "../lib/passwords";
import { requireUsername } from "../lib/usernames";
import { openSession, roleHolds, signedIn } from "../sessions";

/** Someone acting on accounts: a caller, or the maker of a link. */
export interface Actor {
  readonly userId: Id<"users">;
  readonly role: Role;
}

/** Whether `actor` may change `target`'s account: an admin, acting on someone else, who is not the owner. */
export const manages = (actor: Actor, target: Doc<"users">): boolean =>
  roleHolds(actor.role, "admin") && actor.userId !== target._id && target.role !== "owner";

/** Why `actor` may not change `target`'s account, as a refusal. */
const refuseToManage = (actor: Actor, target: Doc<"users">): never => {
  if (target.role === "owner") {
    return fail("forbidden", "No admin can change the owner's account");
  }

  return actor.userId === target._id
    ? fail("forbidden", "Change your own account from your own settings")
    : fail("forbidden", "Only an admin can change someone's account");
};

/** The owner, or null before setup. Throws if a second owner ever exists. */
export const ownerOf = (db: DatabaseReader): Promise<Doc<"users"> | null> =>
  db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .unique();

const refuseTakenKey = async (db: DatabaseReader, usernameKey: string): Promise<void> => {
  const taken = await db
    .query("users")
    .withIndex("by_username_key", (q) => q.eq("usernameKey", usernameKey))
    .first();

  if (taken !== null) fail("conflict", "That username is taken");
};

/**
 * Makes a user with a password hash: the only code that inserts into `users`. The first user must
 * be the owner and there is never a second, so the owner comes only from setup.
 */
export const insertUser = async (
  ctx: Pick<MutationCtx, "db">,
  user: { readonly username: string; readonly hash: string; readonly role: Role },
): Promise<Doc<"users">> => {
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
    ...parsed,
    role: user.role,
    sessionGeneration: 0,
    keyGeneration: 0,
  });

  await storePassword(ctx.db, userId, user.hash);

  return (await ctx.db.get(userId)) ?? fail("not_found", "The new user vanished");
};

/** Changes a user's username; a change of case alone keeps the folded key. */
export const renameUser = async (
  ctx: Pick<MutationCtx, "db">,
  user: Doc<"users">,
  typed: string,
): Promise<void> => {
  const parsed = requireUsername(typed);

  if (parsed.usernameKey !== user.usernameKey) await refuseTakenKey(ctx.db, parsed.usernameKey);

  await ctx.db.patch(user._id, parsed);
};

/** Makes the owner and signs them in, for the `setup` provider, while the server has none. */
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

/** Stores the user an admin typed in, checking the admin again. */
export const insert = internalMutation({
  args: { username: v.string(), hash: v.string(), role: assignableRole },
  returns: v.id("users"),
  handler: async (ctx, { username, hash, role }) => {
    refuseKeys(await requireCaller(ctx, "admin"));

    return (await insertUser(ctx, { username, hash, role }))._id;
  },
});

const DEFAULT_ROLE: AssignableRole = "member";

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
      { table: "users", index: "by_username_key" },
      paginationOpts,
    );

    return {
      ...page,
      page: page.page.map((user) => ({
        userId: user._id,
        username: user.username,
        role: user.role,
      })),
    };
  },
  setRole: async (ctx, { userId, role }, caller) => {
    const target = (await ctx.db.get(userId)) ?? fail("not_found", "No such user");

    if (!manages(caller, target)) return refuseToManage(caller, target);

    if (target.role !== role) await ctx.db.patch(target._id, { role });

    return null;
  },
  handOverOwnership: async (ctx, { userId }, caller) => {
    if (caller.role !== "owner") return fail("forbidden", "Only the owner hands over ownership");

    if (userId === caller.userId) return fail("invalid_args", "You already own this server");

    const target = (await ctx.db.get(userId)) ?? fail("not_found", "No such user");

    await ctx.db.patch(target._id, { role: "owner" });
    await ctx.db.patch(caller.userId, { role: "admin" });

    return null;
  },
});
