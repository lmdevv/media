import { register } from "../../commands/movies/collections";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { pageRows } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import type { Reach } from "../core/permissions/grants";
import type { Principal } from "../core/permissions/policy";
import { budgetedViewer } from "./access";
import { presentTitleCard } from "./present";
import type { TitleCard } from "./present";
import {
  TITLE_GET,
  callBudget,
  collectionsOf,
  libraryCheck,
  plus,
  queryOf,
  settleRead,
  times,
} from "./reads";
import type { ReadBudget, Reads } from "./reads";

const TITLE_LIMIT = 200;

const COLLECTIONS_PAGE_MAX = 20;

/** Members one call decides at a time. */
const MEMBER_BATCH = 20;

interface Shown {
  /** Every member was decided; false when the budget ran out first. */
  readonly complete: boolean;
  /** How many of the collection's members were decided, counting from its first. */
  readonly decided: number;
  readonly collection: {
    readonly id: Doc<"collections">["_id"];
    readonly name: string;
    readonly overview: string | null;
    readonly artwork: { readonly poster: string | null; readonly backdrop: string | null };
    readonly titles: Array<TitleCard>;
  };
}

interface Context {
  readonly db: DatabaseReader;
  readonly caller: Principal;
  readonly reach: Reach;
}

/** What deciding one member costs at worst: its title, and its library's first check. */
const memberCost = (reach: Reach): Reads => plus(TITLE_GET, libraryCheck(reach));

const membersOf = (db: DatabaseReader, doc: Doc<"collections">, count: number) =>
  db
    .query("collectionItems")
    .withIndex("by_collection_position", (q) => q.eq("collectionId", doc._id))
    .take(count);

/**
 * A collection with the titles of it the caller may see, in its order, deciding members from the
 * `from`th a batch at a time on `budget` until every member is decided or the budget runs out.
 */
const present = async (
  context: Context,
  doc: Doc<"collections">,
  budget: ReadBudget,
  from = 0,
): Promise<Shown> => {
  const { db, caller, reach } = context;
  const seen = budgetedViewer(db, caller, reach, budget);

  const shown = (titles: ReadonlyArray<TitleCard>, decided: number, complete: boolean): Shown => ({
    complete,
    decided,
    collection: {
      id: doc._id,
      name: doc.name,
      overview: doc.overview,
      artwork: { poster: doc.poster, backdrop: doc.backdrop },
      titles: [...titles],
    },
  });

  if (!budget.take(queryOf(TITLE_LIMIT))) return shown([], from, false);

  const members = await membersOf(db, doc, TITLE_LIMIT);

  const decide = async (
    start: number,
    titles: ReadonlyArray<TitleCard>,
    ids: ReadonlySet<string>,
  ): Promise<Shown> => {
    const batch = members.slice(start, start + MEMBER_BATCH);

    if (batch.length === 0) return shown(titles, start, true);

    const decided = await Promise.all(
      batch.map(async (member) => {
        if (!budget.take(TITLE_GET)) return { title: null, seen: "spent" as const };

        const title = await db.get(member.titleId);

        settleRead(budget, TITLE_GET, [title]);

        return title === null
          ? { title, seen: "hidden" as const }
          : { title, seen: await seen(title) };
      }),
    );

    const fresh = decided.flatMap((one) =>
      one.seen === "seen" && !ids.has(one.title._id) ? [one.title] : [],
    );

    const next = [...titles, ...fresh.map(presentTitleCard)];
    const nextIds = new Set([...ids, ...fresh.map((title) => title._id)]);

    const spent = decided.findIndex((one) => one.seen === "spent");

    return spent === -1
      ? decide(start + batch.length, next, nextIds)
      : shown(next, start + spent, false);
  };

  return decide(from, [], new Set());
};

/**
 * Where a collections page starts or ends: after a collection (`member` null), or at one, from
 * its `member`th member, when the budget ran out before any of its earlier members was visible.
 */
interface Position {
  readonly sortKey: string;
  readonly creationTime: number;
  readonly member: number | null;
}

const cursorOf = ({ sortKey, creationTime, member }: Position): string =>
  `${creationTime}:${member ?? "-"}:${sortKey}`;

const positionOf = (cursor: string | null | undefined): Position | null => {
  if (cursor === undefined || cursor === null || cursor === "") return null;

  const [time = "", member = "", ...rest] = cursor.split(":");
  const creationTime = Number(time);
  const index = member === "-" ? null : Number(member);

  if (
    !Number.isFinite(creationTime) ||
    rest.length === 0 ||
    (index !== null && !Number.isInteger(index))
  ) {
    return fail("invalid_args", "This page cursor did not come from this list");
  }

  return { sortKey: rest.join(":"), creationTime, member: index };
};

const after = (doc: Doc<"collections">): Position => ({
  sortKey: doc.sortKey,
  creationTime: doc._creationTime,
  member: null,
});

const isAt = (doc: Doc<"collections">, position: Position): boolean =>
  doc.sortKey === position.sortKey && doc._creationTime === position.creationTime;

/** Up to `count` collections in name order from `position`, in at most two index ranges. */
const collectionsFrom = async (
  db: DatabaseReader,
  position: Position | null,
  count: number,
): Promise<ReadonlyArray<Doc<"collections">>> => {
  if (position === null) return db.query("collections").withIndex("by_sort").take(count);

  const ties = await db
    .query("collections")
    .withIndex("by_sort", (q) => {
      const named = q.eq("sortKey", position.sortKey);

      return position.member === null
        ? named.gt("_creationTime", position.creationTime)
        : named.gte("_creationTime", position.creationTime);
    })
    .take(count);

  const later =
    ties.length >= count
      ? []
      : await db
          .query("collections")
          .withIndex("by_sort", (q) => q.gt("sortKey", position.sortKey))
          .take(count - ties.length);

  return [...ties, ...later];
};

export const { list, get } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);
    const member = memberCost(reach);
    const room = budget.left();
    const start = positionOf(paginationOpts.cursor);
    const end = positionOf(paginationOpts.endCursor);

    const each = plus(plus(collectionsOf(1), queryOf(TITLE_LIMIT)), times(member, TITLE_LIMIT));

    const rows = Math.max(
      1,
      Math.min(
        COLLECTIONS_PAGE_MAX,
        pageRows(paginationOpts.numItems),
        Math.floor(room.ranges / each.ranges),
        Math.floor(room.documents / each.documents),
      ),
    );

    // One more than the page holds, to tell whether more follow, over at most two ranges.
    const reserved = plus(collectionsOf(rows + 1), queryOf(0));

    budget.take(reserved);

    const found = await collectionsFrom(ctx.db, start, rows + 1);

    settleRead(budget, reserved, found);

    const endsAt = end === null ? -1 : found.findIndex((doc) => isAt(doc, end));
    const reachesEnd = endsAt !== -1 && endsAt < rows + (end?.member === null ? 0 : 1);

    const window = reachesEnd
      ? found.slice(0, end?.member === null ? endsAt + 1 : endsAt)
      : found.slice(0, rows);

    const context = { db: ctx.db, caller, reach };

    /**
     * Lists the window's collections in order, each once a member of it is visible, and stops at
     * one whose budget ran out before any was: it is decided on the next page, from where it
     * stopped, never listed unseen nor dropped.
     */
    const walk = async (
      index: number,
      listed: ReadonlyArray<Shown["collection"]>,
    ): Promise<{
      readonly listed: ReadonlyArray<Shown["collection"]>;
      readonly stop: Position | null;
    }> => {
      const doc = window[index];

      if (doc === undefined) return { listed, stop: null };

      const from =
        index === 0 && start !== null && start.member !== null && isAt(doc, start)
          ? start.member
          : 0;

      const shown = await present(context, doc, budget.part(1 / (window.length - index)), from);

      if (shown.collection.titles.length > 0) {
        return walk(index + 1, [...listed, shown.collection]);
      }

      return shown.complete
        ? walk(index + 1, listed)
        : { listed, stop: { ...after(doc), member: shown.decided } };
    };

    const { listed, stop } = await walk(0, []);
    const page = [...listed];
    const last = window.at(-1);

    if (paginationOpts.endCursor !== undefined && paginationOpts.endCursor !== null) {
      const split =
        stop ?? (!reachesEnd && found.length > rows && last !== undefined ? after(last) : null);

      return split === null
        ? { page, isDone: false, continueCursor: paginationOpts.endCursor }
        : {
            page,
            isDone: false,
            continueCursor: paginationOpts.endCursor,
            splitCursor: cursorOf(split),
            pageStatus: "SplitRequired" as const,
          };
    }

    if (stop !== null) return { page, isDone: false, continueCursor: cursorOf(stop) };

    return {
      page,
      isDone: found.length <= rows,
      continueCursor: last === undefined ? (paginationOpts.cursor ?? "") : cursorOf(after(last)),
    };
  },
  get: async (ctx, { collectionId }, caller) => {
    const doc = await ctx.db.get(collectionId);

    if (doc === null) return fail("not_found", "No such collection");

    const reach = await reachOf(ctx.db, caller);
    const { collection } = await present({ db: ctx.db, caller, reach }, doc, callBudget(reach));

    return collection.titles.length === 0 ? fail("not_found", "No such collection") : collection;
  },
});
