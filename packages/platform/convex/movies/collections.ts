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
  readsOf,
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
 * Collections order by sort key, then creation time, then id, as their index does. A range can
 * name the first two, so a position also counts the rows of its sort key and creation time that
 * come before it (`ties`), which an import can make more than one.
 */
interface Position {
  readonly sortKey: string;
  readonly creationTime: number;
  readonly ties: number;
  readonly member: number | null;
}

/** A collection read for a page, with how many rows of its sort key and time come before it. */
interface Placed {
  readonly doc: Doc<"collections">;
  readonly ties: number;
}

const cursorOf = ({ sortKey, creationTime, ties, member }: Position): string =>
  `${creationTime}:${ties}:${member ?? "-"}:${sortKey}`;

const positionOf = (cursor: string | null | undefined): Position | null => {
  if (cursor === undefined || cursor === null || cursor === "") return null;

  const [time = "", tied = "", member = "", ...rest] = cursor.split(":");
  const creationTime = Number(time);
  const ties = Number(tied);
  const index = member === "-" ? null : Number(member);

  if (
    !Number.isFinite(creationTime) ||
    !Number.isInteger(ties) ||
    ties < 0 ||
    rest.length === 0 ||
    (index !== null && (!Number.isInteger(index) || index < 0))
  ) {
    return fail("invalid_args", "This page cursor did not come from this list");
  }

  return { sortKey: rest.join(":"), creationTime, ties, member: index };
};

const tiedWith = (doc: Doc<"collections">, position: Position): boolean =>
  doc.sortKey === position.sortKey && doc._creationTime === position.creationTime;

/** The position just after a collection. */
const after = ({ doc, ties }: Placed): Position => ({
  sortKey: doc.sortKey,
  creationTime: doc._creationTime,
  ties: ties + 1,
  member: null,
});

/** The position at a collection, from its `member`th member. */
const at = ({ doc, ties }: Placed, member: number): Position => ({
  sortKey: doc.sortKey,
  creationTime: doc._creationTime,
  ties,
  member,
});

/** Whether `placed` is the collection a position starts at (`at`) or ends after (`after`). */
const isAt = (placed: Placed, position: Position): boolean =>
  tiedWith(placed.doc, position) &&
  placed.ties === (position.member === null ? position.ties - 1 : position.ties);

/** Whether two collections share a sort key and a creation time, which only their ids order. */
const sameRank = (left: Doc<"collections">, right: Doc<"collections">): boolean =>
  left.sortKey === right.sortKey && left._creationTime === right._creationTime;

/** The index ranges `collectionsFrom` reads from a position: the rest of its key, later keys. */
const FROM_RANGES = 2;

/**
 * Up to `count` collections in index order from `position`: the rest of its sort key from its
 * creation time on, past the `ties` that come before it, then later sort keys. Each comes with
 * how many rows of its sort key and time precede it.
 */
const collectionsFrom = async (
  db: DatabaseReader,
  position: Position | null,
  count: number,
): Promise<{
  readonly found: ReadonlyArray<Placed>;
  readonly passed: ReadonlyArray<Doc<"collections">>;
}> => {
  const read = async (): Promise<{
    readonly docs: ReadonlyArray<Doc<"collections">>;
    readonly passed: ReadonlyArray<Doc<"collections">>;
  }> => {
    if (position === null) {
      return { docs: await db.query("collections").withIndex("by_sort").take(count), passed: [] };
    }

    // Its sort key from its creation time on: the `ties` passed already come first, in order.
    const tiesAndAfter = await db
      .query("collections")
      .withIndex("by_sort", (q) =>
        q.eq("sortKey", position.sortKey).gte("_creationTime", position.creationTime),
      )
      .take(position.ties + count);

    const sameKey = tiesAndAfter.slice(position.ties);

    const later =
      sameKey.length >= count
        ? []
        : await db
            .query("collections")
            .withIndex("by_sort", (q) => q.gt("sortKey", position.sortKey))
            .take(count - sameKey.length);

    return { docs: [...sameKey, ...later], passed: tiesAndAfter.slice(0, position.ties) };
  };

  const { docs, passed } = await read();

  /** How many rows of the `index`th collection's sort key and time come before it. */
  const tiesAt = (index: number): number => {
    const doc = docs[index];
    const previous = docs[index - 1];

    if (doc === undefined) return 0;

    if (previous !== undefined && sameRank(previous, doc)) return tiesAt(index - 1) + 1;

    return position !== null && tiedWith(doc, position) ? position.ties : 0;
  };

  return { found: docs.map((doc, index) => ({ doc, ties: tiesAt(index) })), passed };
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

    // One more than the page holds, to tell whether more follow, and the ties it passes over.
    const reserved = plus(
      readsOf(FROM_RANGES - 1, 0, 0),
      collectionsOf(rows + 1 + (start?.ties ?? 0)),
    );

    budget.take(reserved);

    const { found, passed } = await collectionsFrom(ctx.db, start, rows + 1);

    settleRead(budget, reserved, [...passed, ...found.map((placed) => placed.doc)]);

    const endsAt = end === null ? -1 : found.findIndex((placed) => isAt(placed, end));
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
      const placed = window[index];

      if (placed === undefined) return { listed, stop: null };

      const from =
        index === 0 && start !== null && start.member !== null && isAt(placed, start)
          ? start.member
          : 0;

      const shown = await present(
        context,
        placed.doc,
        budget.part(1 / (window.length - index)),
        from,
      );

      if (shown.collection.titles.length > 0) {
        return walk(index + 1, [...listed, shown.collection]);
      }

      return shown.complete ? walk(index + 1, listed) : { listed, stop: at(placed, shown.decided) };
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
