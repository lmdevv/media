import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { paginate } from "../core/lib/paginate";
import { purgeStep } from "../core/scans";
import type { PurgeScope } from "../core/scans";
import { CALL_BUDGET, budgetFor, whileBudget, work } from "./budget";
import type { Budget, Work } from "./budget";
import { adjustPresent, purgingKey } from "./catalog";
import { forgetTotals, moveTotals, nothingMoved } from "./totals";
import { forgetTrickplay } from "./trickplayState";

type Db = MutationCtx["db"];

/** Files one purge page reads at most, as the core's purge contract pages (ADR 0024). */
const FILES_PAGE = 500;

/** Titles one page reads. */
const TITLES_PAGE = 10;

/** The rows of one kind one query of a title's children takes. */
const ROWS_PER_QUERY = 200;

/** A page's own work: the page read, the library and its folders, and the counters. */
const PAGE_COST = work(20, 8);

/**
 * Deleting one file: its thumbnail job read and canceled and its state cleared (8 ranges, 4
 * writes), its title's and episode's present counts (4, 2), and the file (1, 1).
 */
const FILE_COST = work(13, 7);

/** Whether a title still has a file: one index range. */
const CHECK_COST = work(1, 0);

/** Marking a title: the title patched and the library's episode total moved. */
const MARK_COST = work(4, 3);

/** Listing one kind of a title's children: one index range. */
const LIST_COST = work(1, 0);

/** Deleting one row: one range and one write. */
const ROW_COST = work(1, 1);

const cursorArgs = { libraryId: v.id("libraries"), cursor: v.union(v.string(), v.null()) };

/** Where a purge stage goes next: the same page again when the budget stopped it partway. */
export interface PurgeNext {
  readonly cursor: string | null;
  readonly more: boolean;
}

/**
 * One page of the purge's first stage: deletes the files of a page of up to 500 that no current
 * folder of the library keeps, or every file once the library is gone, as many as the call's
 * budget admits. When the budget stops it partway, the next call reads the same page again; the
 * files it deleted are gone from it.
 */
export const filesPage = (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  cursor: string | null,
  limit: Work = CALL_BUDGET,
): Promise<PurgeNext> =>
  purgeStep(ctx, libraryId, async (scope) => {
    const found = await paginate(
      ctx.db,
      {
        table: "mediaFiles",
        index: "by_library_path",
        range: (q) => q.eq("libraryId", libraryId),
      },
      { numItems: FILES_PAGE, cursor },
    );

    const leaving = found.page.filter((file) => !scope.keeps(file.path));

    const deleted = await whileBudget(
      budgetFor(PAGE_COST, limit),
      leaving,
      () => FILE_COST,
      async (file) => {
        await forgetTrickplay(ctx, file);

        if (!scope.gone && !file.missing) {
          await adjustPresent(ctx.db, file.titleId, file.episodeId, -1);
        }

        await ctx.db.delete(file._id);
      },
    );

    if (!scope.gone) {
      await moveTotals(ctx.db, libraryId, { ...nothingMoved, files: -deleted.length });
    }

    const value: PurgeNext =
      deleted.length < leaving.length
        ? { cursor, more: true }
        : { cursor: found.continueCursor, more: !found.isDone };

    return { value, added: 0, removed: 0 };
  });

/**
 * The movies purge hook (ADR 0024), first stage: `filesPage` until the files are done, then the
 * `titles` stage.
 */
export const files = internalMutation({
  args: cursorArgs,
  returns: v.null(),
  handler: async (ctx, { libraryId, cursor }) => {
    const next = await filesPage(ctx, libraryId, cursor);

    await ctx.scheduler.runAfter(
      0,
      next.more ? internal.movies.purge.files : internal.movies.purge.titles,
      { libraryId, cursor: next.more ? next.cursor : null },
    );

    return null;
  },
});

/**
 * Takes a title out of every read, list, and total, in one mutation: marks it `purging`, moves
 * its key aside so no scan or writer finds it again, and moves the library's episode total by the
 * title's own episode count, however many seasons hold them. The core's title count moves by the
 * `removed` the page reports. Its files are already gone, since only a title no file plays is
 * purged.
 */
const markPurging = async (db: Db, scope: PurgeScope, title: Doc<"titles">): Promise<void> => {
  await db.patch(title._id, { purging: true, matchKey: purgingKey(title._id) });

  if (!scope.gone) {
    await moveTotals(db, title.libraryId, { ...nothingMoved, episodes: -title.episodeCount });
  }
};

type ChildList = (
  titleId: Id<"titles">,
) => Promise<ReadonlyArray<{ readonly _id: Id<ChildTable> }>>;

type ChildTable = "credits" | "episodes" | "seasons" | "titleGenres" | "collectionItems";

const childLists = (db: Db): ReadonlyArray<ChildList> => [
  (titleId) =>
    db
      .query("credits")
      .withIndex("by_title_episode", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_QUERY),
  (titleId) =>
    db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_QUERY),
  (titleId) =>
    db
      .query("seasons")
      .withIndex("by_title_number", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_QUERY),
  (titleId) =>
    db
      .query("titleGenres")
      .withIndex("by_title", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_QUERY),
  (titleId) =>
    db
      .query("collectionItems")
      .withIndex("by_title", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_QUERY),
];

/**
 * Deletes a marked title's children, one kind at a time, as many as the budget admits, then the
 * title. Answers whether the title is gone; a title left partway is finished by the next call.
 */
const deleteChildren = async (
  db: Db,
  budget: Budget,
  titleId: Id<"titles">,
  lists: ReadonlyArray<ChildList>,
): Promise<boolean> => {
  const [list, ...rest] = lists;

  if (list === undefined) {
    if (!budget.admits(ROW_COST)) return false;

    budget.spend(ROW_COST);
    await db.delete(titleId);

    return true;
  }

  if (!budget.admits(LIST_COST)) return false;

  budget.spend(LIST_COST);

  const rows = await list(titleId);

  const deleted = await whileBudget(
    budget,
    rows,
    () => ROW_COST,
    async (row) => db.delete(row._id),
  );

  if (deleted.length < rows.length) return false;

  return deleteChildren(db, budget, titleId, rows.length === ROWS_PER_QUERY ? lists : rest);
};

/** What the title stage did to one title of a page. */
type TitleStep = "kept" | "deleted" | "stopped";

interface TitlesWalk {
  readonly stopped: boolean;
  /** Titles this call marked, which leave the core's title count now. */
  readonly marked: number;
}

const walkTitles = async (
  db: Db,
  budget: Budget,
  scope: PurgeScope,
  titles: ReadonlyArray<Doc<"titles">>,
  marked = 0,
): Promise<TitlesWalk> => {
  const [title, ...rest] = titles;

  if (title === undefined) return { stopped: false, marked };

  const step = async (): Promise<{ readonly step: TitleStep; readonly marked: number }> => {
    if (!budget.admits(CHECK_COST)) return { step: "stopped", marked: 0 };

    budget.spend(CHECK_COST);

    const orphan =
      scope.gone ||
      title.purging === true ||
      (await db
        .query("mediaFiles")
        .withIndex("by_title", (q) => q.eq("titleId", title._id))
        .first()) === null;

    if (!orphan) return { step: "kept", marked: 0 };

    const marking = title.purging === true ? 0 : 1;

    if (marking === 1) {
      if (!budget.admits(MARK_COST)) return { step: "stopped", marked: 0 };

      budget.spend(MARK_COST);
      await markPurging(db, scope, title);
    }

    const gone = await deleteChildren(db, budget, title._id, childLists(db));

    return { step: gone ? "deleted" : "stopped", marked: marking };
  };

  const done = await step();

  if (done.step === "stopped") return { stopped: true, marked: marked + done.marked };

  return walkTitles(db, budget, scope, rest, marked + done.marked);
};

/**
 * One page of the purge's second stage: deletes the library's titles of a page of 10, by when
 * each was added, that no file plays any more or that an earlier call started deleting, with
 * their episodes, seasons, credits, genre rows, and collection memberships, as many rows as the
 * call's budget admits. It marks a title before deleting any of its rows, which takes it out of
 * every read, list, and total at once (`markPurging`). When the budget stops it partway, even
 * inside a title's children, the next call reads the same page again and goes on. Once the
 * library is gone and its last title went, its episode and file totals go too.
 */
export const titlesPage = (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  cursor: string | null,
  limit: Work = CALL_BUDGET,
): Promise<PurgeNext> =>
  purgeStep(ctx, libraryId, async (scope) => {
    const found = await paginate(
      ctx.db,
      {
        table: "titles",
        index: "by_library_added",
        range: (q) => q.eq("libraryId", libraryId),
      },
      { numItems: TITLES_PAGE, cursor },
    );

    const walked = await walkTitles(ctx.db, budgetFor(PAGE_COST, limit), scope, found.page);

    const value: PurgeNext = walked.stopped
      ? { cursor, more: true }
      : { cursor: found.continueCursor, more: !found.isDone };

    if (!value.more && scope.gone) await forgetTotals(ctx.db, libraryId);

    return { value, added: 0, removed: walked.marked };
  });

/** The movies purge hook, second stage: `titlesPage` until no title is left to delete. */
export const titles = internalMutation({
  args: cursorArgs,
  returns: v.null(),
  handler: async (ctx, { libraryId, cursor }) => {
    const next = await titlesPage(ctx, libraryId, cursor);

    if (next.more) {
      await ctx.scheduler.runAfter(0, internal.movies.purge.titles, {
        libraryId,
        cursor: next.cursor,
      });
    }

    return null;
  },
});
