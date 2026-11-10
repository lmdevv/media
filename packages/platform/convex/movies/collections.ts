import { register } from "../../commands/movies/collections";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import type { Reach } from "../core/permissions/grants";
import type { Principal } from "../core/permissions/policy";
import { budgetedViewer } from "./access";
import { presentTitleCard } from "./present";
import type { TitleCard } from "./present";
import { TITLE_GET, callBudget, collectionsOf, libraryCheck, plus, queryOf, times } from "./reads";
import type { ReadBudget, Reads } from "./reads";

const TITLE_LIMIT = 200;

const COLLECTIONS_PAGE_MAX = 20;

/** Members one call decides at a time. */
const MEMBER_BATCH = 20;

interface Shown {
  /** Every member was decided; false when the budget ran out first. */
  readonly complete: boolean;
  readonly collection: {
    readonly id: Doc<"collections">["_id"];
    readonly name: string;
    readonly overview: string | null;
    readonly artwork: { readonly poster: string | null; readonly backdrop: string | null };
    readonly titles: ReadonlyArray<TitleCard>;
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
 * A collection with the titles of it the caller may see, in its order, deciding members a batch
 * at a time on `budget` until every member is decided or the budget runs out.
 */
const present = async (
  context: Context,
  doc: Doc<"collections">,
  budget: ReadBudget,
): Promise<Shown> => {
  const { db, caller, reach } = context;
  const seen = budgetedViewer(db, caller, reach, budget);

  const shown = (titles: ReadonlyArray<TitleCard>, complete: boolean): Shown => ({
    complete,
    collection: {
      id: doc._id,
      name: doc.name,
      overview: doc.overview,
      artwork: { poster: doc.poster, backdrop: doc.backdrop },
      titles,
    },
  });

  if (!budget.take(queryOf(TITLE_LIMIT))) return shown([], false);

  const members = await membersOf(db, doc, TITLE_LIMIT);

  const decide = async (
    start: number,
    titles: ReadonlyArray<TitleCard>,
    ids: ReadonlySet<string>,
  ): Promise<Shown> => {
    const batch = members.slice(start, start + MEMBER_BATCH);

    if (batch.length === 0) return shown(titles, true);

    const decided = await Promise.all(
      batch.map(async (member) => {
        if (!budget.take(TITLE_GET)) return { title: null, seen: "spent" as const };

        const title = await db.get(member.titleId);

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

    return decided.some((one) => one.seen === "spent")
      ? shown(next, false)
      : decide(start + batch.length, next, nextIds);
  };

  return decide(0, [], new Set());
};

/** A collection to list: one with a title the caller sees, or one the budget could not finish. */
const listable = ({ collection, complete }: Shown): boolean =>
  collection.titles.length > 0 || !complete;

export const { list, get } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);
    const member = memberCost(reach);
    const room = budget.left();

    const each = plus(plus(collectionsOf(1), queryOf(TITLE_LIMIT)), times(member, TITLE_LIMIT));

    const rows = Math.max(
      1,
      Math.min(
        COLLECTIONS_PAGE_MAX,
        Math.floor(room.ranges / each.ranges),
        Math.floor(room.documents / each.documents),
        Math.floor(room.bytes / each.bytes),
      ),
    );

    budget.take(collectionsOf(rows));

    const page = await paginateAtMost(
      ctx.db,
      { table: "collections", index: "by_sort" },
      paginationOpts,
      rows,
    );

    const presented = await page.page.reduce<Promise<ReadonlyArray<Shown>>>(
      async (pending, doc, index) => {
        const done = await pending;
        const slice = budget.part(1 / (page.page.length - index));

        return [...done, await present({ db: ctx.db, caller, reach }, doc, slice)];
      },
      Promise.resolve([]),
    );

    return {
      ...page,
      page: presented.flatMap((shown) =>
        listable(shown) ? [{ ...shown.collection, titles: [...shown.collection.titles] }] : [],
      ),
    };
  },
  get: async (ctx, { collectionId }, caller) => {
    const doc = await ctx.db.get(collectionId);

    if (doc === null) return fail("not_found", "No such collection");

    const reach = await reachOf(ctx.db, caller);
    const { collection } = await present({ db: ctx.db, caller, reach }, doc, callBudget(reach));

    return collection.titles.length === 0
      ? fail("not_found", "No such collection")
      : { ...collection, titles: [...collection.titles] };
  },
});
