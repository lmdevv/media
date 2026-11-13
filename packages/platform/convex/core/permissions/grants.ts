import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";

import { levels, resourceTypes } from "../../../commands/access";
import type { GrantPrincipal, Level, ResourceType } from "../../../commands/access";
import { register } from "../../../commands/core/permissions/grants";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../../_generated/server";
import type { LinkDoc } from "../guests/model";
import { guestLinkOf } from "../guests/standing";
import type { ShareStanding } from "../guests/standing";
import { fail } from "../lib/errors";
import { inOrder } from "../lib/inOrder";
import { PAGE_ROWS_MAX, pageRows, paginate } from "../lib/paginate";
import { memberIn, placeOf } from "../together/access";
import type { SessionDoc } from "../together/access";
import { can, contentNeeds, itemOf, resourceOf } from "./policy";
import type {
  ContentAction,
  ContentFacts,
  Principal,
  ResourceIdOf,
  ResourceRef,
  ShareSeat,
  TableOf,
} from "./policy";

/** Most groups one person is in; it bounds the reads of every content check. */
export const GROUPS_PER_USER_MAX = 16;

/** Grants one resource holds at most. */
export const RESOURCE_GRANTS_MAX = 1000;

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

/** The grant `key` (a user id, a group id, or `household`) holds on `ref`, or null. */
export const grantOn = <T extends ResourceType>(
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

/**
 * The grants on `ref` in principal order, at most `count` and never more than the 1,000 a
 * resource holds, for a domain that shows who something is shared with.
 */
export const grantsOn = <T extends ResourceType>(
  db: DatabaseReader,
  ref: ResourceRef<T>,
  count: number = RESOURCE_GRANTS_MAX,
): Promise<Array<Doc<"grants">>> =>
  db
    .query("grants")
    .withIndex("by_resource_principal", (q) =>
      q.eq("resourceType", ref.type).eq("resourceId", ref.id),
    )
    .take(Math.min(count, RESOURCE_GRANTS_MAX));

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

/**
 * What a guest's share link lends them (ADR 0007): the link, its standing, its maker's own reach,
 * and for a session link the session and where the guest sits in it. Each item a guest asks for
 * is decided at what the maker may play.
 */
export interface Lent {
  readonly link: LinkDoc;
  readonly standing: ShareStanding;
  readonly maker: Reach;
  readonly session: { readonly doc: SessionDoc; readonly seat: ShareSeat } | null;
}

/**
 * Whose grants reach a principal. Read it once per call and share it across every check. A guest
 * holds no grant, so `direct` and `groups` are empty and every list and every grant check hides
 * everything from them; what they may play comes only from `lent`.
 */
export interface Reach {
  readonly principal: Principal;
  readonly direct: ReadonlyArray<PrincipalKey>;
  readonly groups: ReadonlyArray<Id<"groups">>;
  /** A guest's share link; null for everyone else, and for a guest whose link or maker is gone. */
  readonly lent: Lent | null;
}

const householdReach = async (db: DatabaseReader, principal: Principal): Promise<Reach> => ({
  principal,
  direct: [principal.userId, "household"],
  groups: await groupsOf(db, principal.userId),
  lent: null,
});

const seatIn = async (
  db: DatabaseReader,
  session: SessionDoc,
  guestId: Id<"users">,
): Promise<ShareSeat> => ({
  place: placeOf(session, guestId, await memberIn(db, guestId, session.item.domain)),
  live: session.state === "live",
});

const lentTo = async (db: DatabaseReader, guestId: Id<"users">): Promise<Lent | null> => {
  const guest = await db.get(guestId);

  if (guest?.kind !== "person" || guest.role !== "guest") return null;

  const found = await guestLinkOf(db, guest, Date.now());

  if (found === null) return null;

  const { link, standing } = found;
  const session = link.target.kind === "session" ? await db.get(link.target.sessionId) : null;

  return {
    link,
    standing,
    maker: await householdReach(db, standing.maker.principal),
    session: session === null ? null : { doc: session, seat: await seatIn(db, session, guestId) },
  };
};

/**
 * Reads `principal`'s reach: 1 index range and a document per group. For a guest it reads their
 * row, their link, the switch, its maker, the maker's groups, and a session link's session and seat.
 */
export const reachOf = async (db: DatabaseReader, principal: Principal): Promise<Reach> => {
  if (principal.kind === "service") return { principal, direct: [], groups: [], lent: null };

  if (principal.role === "guest") {
    return { principal, direct: [], groups: [], lent: await lentTo(db, principal.userId) };
  }

  return householdReach(db, principal);
};

/** What a list call reads besides its rows: the caller, their session, and the page's own reads. */
export const LIST_CALL_READS = 16;

/** What a guest's row costs on top of its maker's: the read that says whether the link covers it. */
export const LENT_ROW_READS = 1;

/**
 * The most rows one page may decide through grants for `reach` when each row reads `rowReads`
 * documents of its own, so the call reads at most `PAGE_ROWS_MAX` documents and index ranges. A
 * guest's rows are decided through its maker's grants.
 */
export const decidableRows = (reach: Reach, rowReads: number): number => {
  const charged = reach.lent?.maker ?? reach;
  const lentReads = reach.lent === null ? 0 : LENT_ROW_READS;

  return Math.floor(
    (PAGE_ROWS_MAX - LIST_CALL_READS - charged.groups.length) /
      (rowReads + lentReads + charged.direct.length + charged.groups.length),
  );
};

/** The strongest level any grant in `reach` gives on `ref`. */
export const levelOn = async <T extends ResourceType>(
  db: DatabaseReader,
  reach: Reach,
  ref: ResourceRef<T>,
): Promise<Level | null> => {
  const directGrants = await Promise.all(reach.direct.map(async (key) => grantOn(db, ref, key)));
  const direct = strongest(directGrants.map((grant) => grant?.level ?? null));

  if (direct === "manage") return direct;

  const viaGroups = await Promise.all(
    reach.groups.map(async (groupId) => grantOn(db, ref, groupId)),
  );

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
  const [found, reach] = await Promise.all([ctx.db.get(ref.id), reachOf(ctx.db, caller)]);
  const doc = found ?? fail("not_found", missing);
  const level = await levelOn(ctx.db, reach, ref);
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

/** What a domain decides on the items of one library: the library once, then each item's facts. */
export interface ItemGate {
  readonly library: Doc<"libraries">;
  readonly level: Level;
  /**
   * Whether `can` allows the action on an item of the library with these facts. An item it refuses
   * is hidden: a list drops it, and a lookup answers as for a missing one.
   */
  readonly admits: (facts: ContentFacts) => boolean;
}

/**
 * Loads `libraryId` and decides `action` on its items for `caller`. An item has no grants of its
 * own: it is seen at its library's level, so a hidden library fails `not_found` and a missing
 * scope or level fails `forbidden` here, as `requireContent` does. Each item's facts then go
 * through `can` in `admits`.
 */
export const requireItems = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  action: ContentAction,
  libraryId: Id<"libraries">,
): Promise<ItemGate> => {
  const { doc, level } = await requireContent(ctx, caller, action, {
    type: "library",
    id: libraryId,
  });

  return {
    library: doc,
    level,
    admits: (facts) => can(caller, action, itemOf(doc, level, facts)).allowed,
  };
};

interface Bounds<T extends ResourceType> {
  readonly after: ResourceIdOf<T> | null;
  /** Only rows up to this id, for a reactive page reloaded to the end it had; null for no end. */
  readonly through: ResourceIdOf<T> | null;
}

type IdReaders = {
  readonly [T in ResourceType]: (db: DatabaseReader, raw: string) => ResourceIdOf<T> | null;
};

/** Reads a raw id as a row of each resource type's table, or null when it names none. */
const idReaders: IdReaders = {
  library: (db, raw) => db.normalizeId("libraries", raw),
  playlist: (db, raw) => db.normalizeId("playlists", raw),
};

const boundOf = <T extends ResourceType>(
  db: DatabaseReader,
  type: T,
  cursor: string | null | undefined,
): ResourceIdOf<T> | null =>
  cursor === undefined || cursor === null || cursor === ""
    ? null
    : (idReaders[type](db, cursor) ??
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

  const reach = await reachOf(ctx.db, principal);
  const keys = [...reach.direct, ...reach.groups];
  const fits = Math.floor((PAGE_ROWS_MAX - reach.groups.length - keys.length) / (keys.length + 1));

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
      const id = idReaders[type](ctx.db, rawId);
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
 * Whether a share may give `principal` `level` on a row of `type` (`shares` in the resource type
 * registry): only a person may manage, and a playlist goes to a person or to everyone, never to a
 * group.
 */
const sharable = (type: ResourceType, principal: GrantPrincipal, level: Level): boolean => {
  const allowed: ReadonlyArray<Level> = resourceTypes[type].shares[principal.kind];

  return allowed.includes(level);
};

const refusedShare = (type: ResourceType, principal: GrantPrincipal, level: Level): never => {
  if (level === "manage" && principal.kind !== "user") {
    return fail("invalid_args", "Only a person can manage something");
  }

  return fail(
    "invalid_args",
    type === "playlist"
      ? "Share a playlist with a person to view or edit, or with everyone to view"
      : `A ${type} cannot give ${level} to a ${principal.kind}`,
  );
};

/**
 * Gives `principal` exactly `level` on `ref`, which needs `manage` on it. Only a person may
 * manage; a group or the household gets `view` or `edit`, and each resource type may narrow that
 * further (`shares`). Running it twice changes nothing, and lowering the last manager is a
 * `conflict`.
 */
export const grant = async <T extends ResourceType>(
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  ref: ResourceRef<T>,
  principal: GrantPrincipal,
  level: Level,
): Promise<void> => {
  await requireContent(ctx, caller, "manage", ref);

  if (!sharable(ref.type, principal, level)) return refusedShare(ref.type, principal, level);

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
 * Stops sharing `ref` with anyone but its managers, which needs `manage` on it: every `view` and
 * `edit` grant goes, the household's included, as old music's unshare with no one named did. A
 * resource has at most 1,000 grants, so this reads and deletes at most that many.
 */
export const unshareAll = async <T extends ResourceType>(
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  ref: ResourceRef<T>,
): Promise<void> => {
  await requireContent(ctx, caller, "manage", ref);

  const leaving = (await grantsOn(ctx.db, ref)).filter((row) => row.level !== "manage");

  await Promise.all(leaving.map(async (row) => ctx.db.delete(row._id)));
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

/**
 * Shares a row made in this same mutation, after `grantCreator`: each principal gets its level
 * unless it already holds a grant on the row, so the creator keeps `manage` and a repeat changes
 * nothing. It reads the row's grants once, where a `grant` per principal would read them each
 * time, and keeps the row within its 1,000 grants.
 *
 * @throws Error when a share gives a level its resource type does not allow that principal (a group
 * or the household as a manager), which only a defect gives.
 */
export const shareNew = async <T extends ResourceType>(
  ctx: Pick<MutationCtx, "db">,
  ref: ResourceRef<T>,
  shares: ReadonlyArray<{ readonly principal: GrantPrincipal; readonly level: Level }>,
): Promise<void> => {
  const held = new Set((await grantsOn(ctx.db, ref)).map((row) => row.principal));

  await inOrder(shares, async ({ principal, level }) => {
    if (!sharable(ref.type, principal, level)) {
      throw new Error(`A ${ref.type} cannot give ${level} to a ${principal.kind}`);
    }

    const key = await keyOf(ctx.db, principal);

    if (held.has(key)) return;

    if (held.size >= RESOURCE_GRANTS_MAX) {
      fail("conflict", `Something can be shared at most ${RESOURCE_GRANTS_MAX} ways`);
    }

    held.add(key);

    await ctx.db.insert("grants", {
      resourceType: ref.type,
      resourceId: ref.id,
      principal: key,
      level,
    });
  });
};

/**
 * Deletes every grant on `ref`, for the mutation that deletes the row itself. A resource has at
 * most 1,000 grants, so this reads and deletes at most that many.
 */
export const deleteGrantsOn = async <T extends ResourceType>(
  ctx: Pick<MutationCtx, "db">,
  ref: ResourceRef<T>,
): Promise<void> => {
  const grants = await grantsOn(ctx.db, ref);

  await Promise.all(grants.map((row) => ctx.db.delete(row._id)));
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

type SharedWith =
  | { readonly kind: "user"; readonly userId: Id<"users">; readonly username: string }
  | { readonly kind: "group"; readonly groupId: Id<"groups">; readonly name: string }
  | { readonly kind: "household" };

const sharedWith = async (db: DatabaseReader, key: PrincipalKey): Promise<SharedWith | null> => {
  if (key === "household") return { kind: "household" };

  const userId = db.normalizeId("users", key);

  if (userId !== null) {
    const user = await db.get(userId);

    return user?.kind === "person" ? { kind: "user", userId, username: user.username } : null;
  }

  const groupId = db.normalizeId("groups", key);
  const group = groupId === null ? null : await db.get(groupId);

  return group === null ? null : { kind: "group", groupId: group._id, name: group.name };
};

export const { set, remove, list } = register({
  set: async (ctx, { resource, principal, level }, caller) => {
    await grant(ctx, caller, resource, principal, level);

    return null;
  },
  remove: async (ctx, { resource, principal }, caller) => {
    await revoke(ctx, caller, resource, principal);

    return null;
  },
  list: async (ctx, { resource, paginationOpts }, caller) => {
    await requireContent(ctx, caller, "manage", resource);

    const page = await paginate(
      ctx.db,
      {
        table: "grants",
        index: "by_resource_principal",
        range: (q) => q.eq("resourceType", resource.type).eq("resourceId", resource.id),
      },
      paginationOpts,
    );

    const rows = await Promise.all(
      page.page.map(async (row) => {
        const principal = await sharedWith(ctx.db, row.principal);

        return principal === null ? [] : [{ principal, level: row.level }];
      }),
    );

    return { ...page, page: rows.flat() };
  },
});
