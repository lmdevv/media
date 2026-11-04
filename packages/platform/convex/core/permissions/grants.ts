import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";

import { levels, resourceTypes } from "../../../commands/access";
import type { GrantPrincipal, Level, ResourceType } from "../../../commands/access";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { PAGE_ROWS_MAX, pageRows, paginate } from "../lib/paginate";
import { can, contentNeeds, resourceOf } from "./policy";
import type { ContentAction, Principal, ResourceRef, TableOf } from "./policy";

/** Most groups one person is in; it bounds the reads of every content check. */
export const GROUPS_PER_USER_MAX = 16;

const RESOURCE_GRANTS_MAX = 1000;

const PURGE_BATCH = 500;

type PrincipalKey = Doc<"grants">["principal"];

/** A row the caller may see, and the strongest level their grants give them on it. */
export interface Visible<T extends ResourceType> {
  readonly doc: Doc<TableOf<T>>;
  readonly level: Level;
}

const strongest = (found: ReadonlyArray<Level | null>): Level | null =>
  found.reduce<Level | null>(
    (best, level) =>
      level !== null && (best === null || levels.indexOf(level) > levels.indexOf(best))
        ? level
        : best,
    null,
  );

const grantOn = <T extends ResourceType>(
  db: DatabaseReader,
  ref: ResourceRef<T>,
  key: PrincipalKey,
): Promise<Doc<"grants"> | null> =>
  db
    .query("grants")
    .withIndex("by_resource_principal", (q) =>
      q.eq("resourceType", ref.type).eq("resourceId", ref.id).eq("principal", key),
    )
    .unique();

const grantsOn = <T extends ResourceType>(
  db: DatabaseReader,
  ref: ResourceRef<T>,
): Promise<Array<Doc<"grants">>> =>
  db
    .query("grants")
    .withIndex("by_resource_principal", (q) =>
      q.eq("resourceType", ref.type).eq("resourceId", ref.id),
    )
    .take(RESOURCE_GRANTS_MAX);

/** The groups a person is in, read live, so a removal applies on their next call. */
export const groupsOf = async (
  db: DatabaseReader,
  userId: Id<"users">,
): Promise<ReadonlyArray<Id<"groups">>> =>
  (
    await db
      .query("groupMembers")
      .withIndex("by_user_group", (q) => q.eq("userId", userId))
      .take(GROUPS_PER_USER_MAX)
  ).map((member) => member.groupId);

const directKeys = (principal: Principal): ReadonlyArray<PrincipalKey> =>
  principal.kind === "service"
    ? []
    : principal.role === "guest"
      ? [principal.userId]
      : [principal.userId, "household"];

/**
 * The strongest level any grant gives `principal` on `ref`: their own, the household's (not for
 * guests), or one of their groups'. A service gets none. Reads 2 grants, then, unless one of them
 * is `manage`, the person's groups and one grant per group.
 */
export const levelOn = async <T extends ResourceType>(
  db: DatabaseReader,
  principal: Principal,
  ref: ResourceRef<T>,
): Promise<Level | null> => {
  const [directGrants, groups] = await Promise.all([
    Promise.all(directKeys(principal).map(async (key) => grantOn(db, ref, key))),
    principal.kind === "service" ? [] : groupsOf(db, principal.userId),
  ]);

  const direct = strongest(directGrants.map((grant) => grant?.level ?? null));

  if (direct === "manage") return direct;

  const viaGroups = await Promise.all(groups.map(async (groupId) => grantOn(db, ref, groupId)));

  return strongest([direct, ...viaGroups.map((grant) => grant?.level ?? null)]);
};

/**
 * Loads `ref` and decides `action` on it for `caller`, and returns the row and the caller's
 * level. A row the caller may not see fails `not_found` with the same message as a missing one;
 * one they see but may not do this to fails `forbidden`.
 */
export const requireContent = async <T extends ResourceType>(
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  action: ContentAction,
  ref: ResourceRef<T>,
): Promise<Visible<T>> => {
  const missing = `No such ${ref.type}`;
  const doc = (await ctx.db.get(ref.id)) ?? fail("not_found", missing);
  const level = await levelOn(ctx.db, caller, ref);
  const resource = resourceOf(ref.type, doc, level);
  const decision = can(caller, action, resource);

  if (!decision.allowed) {
    const needs = contentNeeds(action, resource.domain);

    return decision.refusal === "hidden"
      ? fail("not_found", missing)
      : fail(
          "forbidden",
          decision.because === "scope"
            ? `This session lacks the ${needs.scope} scope`
            : `This needs ${needs.level} access, and you have ${level ?? "none"}`,
        );
  }

  return level === null ? fail("not_found", missing) : { doc, level };
};

interface Bounds<T extends ResourceType> {
  readonly after: Id<TableOf<T>> | null;
  /** Only rows up to this id, for a reactive page reloaded to the end it had; null for no end. */
  readonly through: Id<TableOf<T>> | null;
}

const boundOf = <T extends ResourceType>(
  db: DatabaseReader,
  type: T,
  cursor: string | null | undefined,
): Id<TableOf<T>> | null =>
  cursor === undefined || cursor === null || cursor === ""
    ? null
    : (db.normalizeId(resourceTypes[type].table, cursor) ??
      fail("invalid_args", "This page cursor did not come from this list"));

const rangeOf = <T extends ResourceType>(
  db: DatabaseReader,
  type: T,
  key: PrincipalKey,
  bounds: Bounds<T>,
  rows: number,
): Promise<Array<Doc<"grants">>> =>
  db
    .query("grants")
    .withIndex("by_principal_resource", (q) => {
      const ofType = q.eq("principal", key).eq("resourceType", type);
      const after = bounds.after === null ? ofType : ofType.gt("resourceId", bounds.after);

      return bounds.through === null ? after : after.lte("resourceId", bounds.through);
    })
    .take(rows);

/**
 * One page of the `type` rows the principal may see, by id. It merges the ranges of the person's
 * own grants, the household's, and each group's, keeps the strongest level per row, and drops
 * what `can(principal, "view", ...)` refuses, so a restriction can make a page short. Reads stay
 * under `PAGE_ROWS_MAX` however many grants the table holds: a page holds fewer rows the more
 * groups the person is in. The cursor is the last row id the page considered. A page reloaded up
 * to its `endCursor` holds every row up to it, or asks the client to split it when they no longer
 * fit, so a reactive list never skips a row.
 */
export const visiblePage = async <T extends ResourceType>(
  ctx: Pick<QueryCtx, "db">,
  principal: Principal,
  type: T,
  options: PaginationOptions,
): Promise<PaginationResult<Visible<T>>> => {
  const bounds: Bounds<T> = {
    after: boundOf(ctx.db, type, options.cursor),
    through: boundOf(ctx.db, type, options.endCursor),
  };

  const groups = principal.kind === "service" ? [] : await groupsOf(ctx.db, principal.userId);
  const keys = [...directKeys(principal), ...groups];
  const fits = Math.floor((PAGE_ROWS_MAX - groups.length - keys.length) / (keys.length + 1));

  const rows =
    bounds.through === null ? Math.max(1, Math.min(pageRows(options.numItems), fits)) : fits;

  const ranges = await Promise.all(
    keys.map(async (key) => rangeOf(ctx.db, type, key, bounds, rows + 1)),
  );

  const levelsById = new Map<string, Level>();

  for (const found of ranges.flat()) {
    levelsById.set(
      found.resourceId,
      strongest([levelsById.get(found.resourceId) ?? null, found.level]) ?? found.level,
    );
  }

  const ids = [...levelsById.keys()].toSorted();
  const considered = ids.slice(0, rows);

  const loaded = await Promise.all(
    considered.map(async (rawId) => {
      const id = ctx.db.normalizeId(resourceTypes[type].table, rawId);
      const doc = id === null ? null : await ctx.db.get(id);
      const level = levelsById.get(rawId) ?? null;

      return doc === null || level === null ? [] : [{ doc, level }];
    }),
  );

  const page = loaded
    .flat()
    .filter(({ doc, level }) => can(principal, "view", resourceOf(type, doc, level)).allowed);

  if (bounds.through === null) {
    return {
      page,
      isDone: ids.length <= rows,
      continueCursor: considered.at(-1) ?? bounds.after ?? "",
    };
  }

  const split = considered.at(-1);

  return ids.length > rows && split !== undefined
    ? {
        page,
        isDone: false,
        continueCursor: bounds.through,
        splitCursor: split,
        pageStatus: "SplitRequired",
      }
    : { page, isDone: false, continueCursor: bounds.through };
};

const storedKey = (principal: GrantPrincipal): PrincipalKey => {
  if (principal.kind === "user") return principal.userId;

  return principal.kind === "group" ? principal.groupId : "household";
};

const keyOf = async (db: DatabaseReader, principal: GrantPrincipal): Promise<PrincipalKey> => {
  if (principal.kind === "household") return storedKey(principal);

  if (principal.kind === "group") {
    return (await db.get(principal.groupId)) === null
      ? fail("not_found", "No such group")
      : principal.groupId;
  }

  const user = await db.get(principal.userId);

  if (user?.kind !== "person") return fail("not_found", "No such user");

  return user.role === "guest"
    ? fail("invalid_args", "Guests get access only from the link that made them")
    : user._id;
};

const refuseLosingLastManager = (
  grants: ReadonlyArray<Doc<"grants">>,
  leaving: Doc<"grants">,
): void => {
  if (
    leaving.level === "manage" &&
    !grants.some((other) => other._id !== leaving._id && other.level === "manage")
  ) {
    fail("conflict", "Someone else must manage this first");
  }
};

/**
 * Gives `principal` exactly `level` on `ref`, which needs `manage` on it. Only a person may
 * manage; a group or the household gets `view` or `edit`. Running it twice changes nothing, and
 * lowering the last manager is a `conflict`.
 */
export const grant = async <T extends ResourceType>(
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  ref: ResourceRef<T>,
  principal: GrantPrincipal,
  level: Level,
): Promise<void> => {
  await requireContent(ctx, caller, "manage", ref);

  if (level === "manage" && principal.kind !== "user") {
    return fail("invalid_args", "Only a person can manage something");
  }

  const key = await keyOf(ctx.db, principal);
  const existing = await grantOn(ctx.db, ref, key);

  if (existing?.level === level) return;

  const grants = await grantsOn(ctx.db, ref);

  if (existing !== null) {
    if (level !== "manage") refuseLosingLastManager(grants, existing);

    await ctx.db.patch(existing._id, { level });

    return;
  }

  if (grants.length >= RESOURCE_GRANTS_MAX) {
    return fail("conflict", `Something can be shared at most ${RESOURCE_GRANTS_MAX} ways`);
  }

  await ctx.db.insert("grants", {
    resourceType: ref.type,
    resourceId: ref.id,
    principal: key,
    level,
  });
};

/**
 * Takes `principal`'s grant on `ref` away. It needs `manage`, except that a person who can see
 * `ref` may leave what was shared with them. Removing the last manager is a `conflict`; a missing
 * grant is no change.
 */
export const revoke = async <T extends ResourceType>(
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  ref: ResourceRef<T>,
  principal: GrantPrincipal,
): Promise<void> => {
  const leaving = principal.kind === "user" && principal.userId === caller.userId;

  await requireContent(ctx, caller, leaving ? "view" : "manage", ref);

  const existing = await grantOn(ctx.db, ref, storedKey(principal));

  if (existing === null) return;

  refuseLosingLastManager(await grantsOn(ctx.db, ref), existing);

  await ctx.db.delete(existing._id);
};

/**
 * Makes `userId` the first manager of a row made in this same mutation.
 *
 * @throws Error when the row already has a grant, which only a defect gives.
 */
export const grantCreator = async <T extends ResourceType>(
  ctx: Pick<MutationCtx, "db">,
  ref: ResourceRef<T>,
  userId: Id<"users">,
): Promise<void> => {
  if ((await grantsOn(ctx.db, ref)).length > 0) {
    throw new Error(`${ref.type} ${ref.id} already has grants; only a new row gets a creator`);
  }

  await ctx.db.insert("grants", {
    resourceType: ref.type,
    resourceId: ref.id,
    principal: userId,
    level: "manage",
  });
};

/** Schedules deleting every grant of a removed group, a page at a time. */
export const purgeGrantsOf = async (
  ctx: Pick<MutationCtx, "scheduler">,
  groupId: Id<"groups">,
): Promise<void> => {
  await ctx.scheduler.runAfter(0, internal.core.permissions.grants.purge, {
    groupId,
    cursor: null,
  });
};

/** Deletes one page of a removed group's grants, and schedules the next page. */
export const purge = internalMutation({
  args: { groupId: v.id("groups"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { groupId, cursor }) => {
    const page = await paginate(
      ctx.db,
      {
        table: "grants",
        index: "by_principal_resource",
        range: (q) => q.eq("principal", groupId),
      },
      { numItems: PURGE_BATCH, cursor },
    );

    await Promise.all(page.page.map((row) => ctx.db.delete(row._id)));

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.core.permissions.grants.purge, {
        groupId,
        cursor: page.continueCursor,
      });
    }

    return null;
  },
});
