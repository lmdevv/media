import { register } from "../../../commands/core/permissions/groups";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { fail } from "../lib/errors";
import { paginate } from "../lib/paginate";
import { requireAccount, requireServer } from "./authorize";
import { GROUPS_PER_USER_MAX, groupsOf, purgeGrantsOf } from "./grants";

const NAME_MAX = 64;

/** Most people in one group, so removing a group deletes its memberships in one call. */
const GROUP_MEMBERS_MAX = 500;

const parseName = (typed: string): Pick<Doc<"groups">, "name" | "nameKey"> => {
  const name = typed.trim();

  return name.length === 0 || name.length > NAME_MAX
    ? fail("invalid_args", `Name a group with 1 to ${NAME_MAX} characters`)
    : { name, nameKey: name.toLowerCase() };
};

const refuseTakenName = async (
  db: DatabaseReader,
  nameKey: string,
  renaming?: Id<"groups">,
): Promise<void> => {
  const taken = await db
    .query("groups")
    .withIndex("by_name_key", (q) => q.eq("nameKey", nameKey))
    .first();

  if (taken !== null && taken._id !== renaming) fail("conflict", "A group has that name already");
};

const requireGroup = async (db: DatabaseReader, groupId: Id<"groups">): Promise<Doc<"groups">> =>
  (await db.get(groupId)) ?? fail("not_found", "No such group");

const membersOf = (db: DatabaseReader, groupId: Id<"groups">) =>
  db.query("groupMembers").withIndex("by_group_user", (q) => q.eq("groupId", groupId));

const membership = (
  db: DatabaseReader,
  groupId: Id<"groups">,
  userId: Id<"users">,
): Promise<Doc<"groupMembers"> | null> =>
  db
    .query("groupMembers")
    .withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", userId))
    .unique();

export const { create, rename, remove, list, members, addMember, removeMember } = register({
  create: async (ctx, { name }, caller) => {
    requireServer(caller, "manageGroups");

    const parsed = parseName(name);

    await refuseTakenName(ctx.db, parsed.nameKey);

    return { groupId: await ctx.db.insert("groups", parsed) };
  },
  rename: async (ctx, { groupId, name }, caller) => {
    requireServer(caller, "manageGroups");

    const group = await requireGroup(ctx.db, groupId);
    const parsed = parseName(name);

    await refuseTakenName(ctx.db, parsed.nameKey, group._id);
    await ctx.db.patch(group._id, parsed);

    return null;
  },
  remove: async (ctx, { groupId }, caller) => {
    requireServer(caller, "manageGroups");

    const group = await requireGroup(ctx.db, groupId);
    const memberships = await membersOf(ctx.db, group._id).take(GROUP_MEMBERS_MAX);

    await Promise.all(memberships.map((member) => ctx.db.delete(member._id)));
    await ctx.db.delete(group._id);
    await purgeGrantsOf(ctx, group._id);

    return null;
  },
  list: async (ctx, { paginationOpts }, caller) => {
    requireServer(caller, "manageGroups");

    const page = await paginate(ctx.db, { table: "groups", index: "by_name_key" }, paginationOpts);

    return {
      ...page,
      page: page.page.map((group) => ({ groupId: group._id, name: group.name })),
    };
  },
  members: async (ctx, { groupId, paginationOpts }, caller) => {
    requireServer(caller, "manageGroups");

    const group = await requireGroup(ctx.db, groupId);

    const page = await paginate(
      ctx.db,
      { table: "groupMembers", index: "by_group_user", range: (q) => q.eq("groupId", group._id) },
      paginationOpts,
    );

    const people = await Promise.all(page.page.map(async (member) => ctx.db.get(member.userId)));

    return {
      ...page,
      page: people.flatMap((person) =>
        person?.kind === "person" ? [{ userId: person._id, username: person.username }] : [],
      ),
    };
  },
  addMember: async (ctx, { groupId, userId }, caller) => {
    requireServer(caller, "manageGroups");

    const group = await requireGroup(ctx.db, groupId);
    const person = await requireAccount(ctx, caller, "joinGroup", userId);

    if ((await membership(ctx.db, group._id, person._id)) !== null) return null;

    if ((await membersOf(ctx.db, group._id).take(GROUP_MEMBERS_MAX)).length >= GROUP_MEMBERS_MAX) {
      return fail("conflict", `A group holds at most ${GROUP_MEMBERS_MAX} people`);
    }

    if ((await groupsOf(ctx.db, person._id)).length >= GROUPS_PER_USER_MAX) {
      return fail("conflict", `A person can be in at most ${GROUPS_PER_USER_MAX} groups`);
    }

    await ctx.db.insert("groupMembers", { groupId: group._id, userId: person._id });

    return null;
  },
  removeMember: async (ctx, { groupId, userId }, caller) => {
    requireServer(caller, "manageGroups");

    const found = await membership(ctx.db, groupId, userId);

    if (found !== null) await ctx.db.delete(found._id);

    return null;
  },
});
