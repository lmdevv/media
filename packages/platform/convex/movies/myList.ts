import { register } from "../../commands/movies/myList";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { paginateAtMost } from "../core/lib/paginate";
import { decidableRows, reachOf } from "../core/permissions/grants";
import { requireTitle, titleViewer } from "./access";
import { registerWithArtworkTickets } from "./artwork";
import { presentTitleCard } from "./present";
import { insertListEntry } from "./write";

const LIST_PAGE_MAX = 200;

/** What one entry reads besides its grant checks: the entry, its title, and its library. */
const LIST_ROW_READS = 3;

const entryOf = (db: DatabaseReader, userId: Id<"users">, titleId: Id<"titles">) =>
  db
    .query("myList")
    .withIndex("by_user_title", (q) => q.eq("userId", userId).eq("titleId", titleId))
    .unique();

export const { list, add, remove } = registerWithArtworkTickets(register, {
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const sees = titleViewer(ctx.db, caller, reach);

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "myList",
        index: "by_user_added",
        range: (q) => q.eq("userId", caller.userId),
        order: "desc",
      },
      paginationOpts,
      Math.min(LIST_PAGE_MAX, decidableRows(reach, LIST_ROW_READS)),
    );

    const titles = await Promise.all(
      page.page.map(async (entry) => {
        const title = await ctx.db.get(entry.titleId);

        return title !== null && (await sees(title)) ? [presentTitleCard(title)] : [];
      }),
    );

    return { ...page, page: titles.flat() };
  },
  add: async (ctx, { titleId }, caller) => {
    await requireTitle(ctx.db, caller, "play", titleId);

    if ((await entryOf(ctx.db, caller.userId, titleId)) === null) {
      await insertListEntry(ctx.db, { userId: caller.userId, titleId, addedAt: Date.now() });
    }

    return null;
  },
  remove: async (ctx, { titleId }, caller) => {
    const entry = await entryOf(ctx.db, caller.userId, titleId);

    if (entry !== null) await ctx.db.delete(entry._id);

    return null;
  },
});
