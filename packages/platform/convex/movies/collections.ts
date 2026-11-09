import { register } from "../../commands/movies/collections";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { titleViewer } from "./access";
import type { TitleViewer } from "./access";
import { presentTitleCard } from "./present";
import type { TitleCard } from "./present";

const TITLE_LIMIT = 200;

const COLLECTIONS_PAGE_MAX = 20;

/** Most members read across one page, so the call stays inside Convex's read limits. */
const MEMBER_BUDGET = 2000;

interface Shown {
  readonly read: number;
  readonly collection: {
    readonly id: Doc<"collections">["_id"];
    readonly name: string;
    readonly overview: string | null;
    readonly artwork: { readonly poster: string | null; readonly backdrop: string | null };
    readonly titles: ReadonlyArray<TitleCard>;
  };
}

const present = async (
  db: DatabaseReader,
  sees: TitleViewer,
  doc: Doc<"collections">,
  limit: number,
): Promise<Shown> => {
  const members =
    limit <= 0
      ? []
      : await db
          .query("collectionItems")
          .withIndex("by_collection_position", (q) => q.eq("collectionId", doc._id))
          .take(limit);

  const titles = await Promise.all(
    members.map(async (member) => {
      const title = await db.get(member.titleId);

      return title !== null && (await sees(title)) ? title : null;
    }),
  );

  const seen = new Set<string>();

  return {
    read: members.length,
    collection: {
      id: doc._id,
      name: doc.name,
      overview: doc.overview,
      artwork: { poster: doc.poster, backdrop: doc.backdrop },
      titles: titles.flatMap((title) => {
        if (title === null || seen.has(title._id)) return [];

        seen.add(title._id);

        return [presentTitleCard(title)];
      }),
    },
  };
};

export const { list, get } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const sees = titleViewer(ctx.db, caller, await reachOf(ctx.db, caller));

    const page = await paginateAtMost(
      ctx.db,
      { table: "collections", index: "by_sort" },
      paginationOpts,
      COLLECTIONS_PAGE_MAX,
    );

    const shown = await page.page.reduce<Promise<{ budget: number; listed: Array<Shown> }>>(
      async (pending, doc) => {
        const { budget, listed } = await pending;
        const presented = await present(ctx.db, sees, doc, Math.min(TITLE_LIMIT, budget));

        return { budget: budget - presented.read, listed: [...listed, presented] };
      },
      Promise.resolve({ budget: MEMBER_BUDGET, listed: [] }),
    );

    return {
      ...page,
      page: shown.listed.flatMap(({ collection }) =>
        collection.titles.length === 0 ? [] : [{ ...collection, titles: [...collection.titles] }],
      ),
    };
  },
  get: async (ctx, { collectionId }, caller) => {
    const doc = await ctx.db.get(collectionId);

    if (doc === null) return fail("not_found", "No such collection");

    const sees = titleViewer(ctx.db, caller, await reachOf(ctx.db, caller));
    const { collection } = await present(ctx.db, sees, doc, TITLE_LIMIT);

    return collection.titles.length === 0
      ? fail("not_found", "No such collection")
      : { ...collection, titles: [...collection.titles] };
  },
});
