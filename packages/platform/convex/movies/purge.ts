import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { inOrder } from "../core/lib/inOrder";
import { paginate } from "../core/lib/paginate";
import { purgeStep } from "../core/scans";
import { adjustPresent, purgingKey } from "./catalog";
import { forgetTotals, moveTotals, nothingMoved } from "./totals";
import { forgetTrickplay } from "./trickplayState";

/** Files one purge call deletes at most, as the core's purge contract pages (ADR 0024). */
const FILES_PAGE = 500;

/** Titles one call looks at: each may cost a few hundred deletes of its own rows. */
const TITLES_PAGE = 10;

/** The most rows of each kind one title's deletion takes per call; the rest wait for the next. */
const ROWS_PER_TITLE = 200;

type TitleRow = "credits" | "episodes" | "seasons" | "titleGenres" | "collectionItems";

const cursorArgs = { libraryId: v.id("libraries"), cursor: v.union(v.string(), v.null()) };

/**
 * One page of the purge's first stage: deletes up to 500 files that no current folder of the
 * library keeps, or every file once the library is gone. Answers the cursor of the next page, or
 * null once the files are done.
 */
export const filesPage = (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  cursor: string | null,
): Promise<string | null> =>
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

    await inOrder(leaving, async (file) => {
      await forgetTrickplay(ctx, file);

      if (!scope.gone && !file.missing) {
        await adjustPresent(ctx.db, file.titleId, file.episodeId, -1);
      }

      await ctx.db.delete(file._id);
    });

    if (!scope.gone) {
      await moveTotals(ctx.db, libraryId, { ...nothingMoved, files: -leaving.length });
    }

    return { value: found.isDone ? null : found.continueCursor, added: 0, removed: 0 };
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
      next === null ? internal.movies.purge.titles : internal.movies.purge.files,
      { libraryId, cursor: next },
    );

    return null;
  },
});

interface TitleDeletion {
  /** Whether the title row itself went: false while its own rows still fill a call. */
  readonly done: boolean;
  readonly episodes: number;
}

/** Deletes up to 200 of each kind of row a title holds, and the title once none is left. */
const deleteTitle = async (db: MutationCtx["db"], title: Doc<"titles">): Promise<TitleDeletion> => {
  const titleId = title._id;

  const [credits, episodes, seasons, genres, memberships] = await Promise.all([
    db
      .query("credits")
      .withIndex("by_title_episode", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_TITLE),
    db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_TITLE),
    db
      .query("seasons")
      .withIndex("by_title_number", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_TITLE),
    db
      .query("titleGenres")
      .withIndex("by_title", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_TITLE),
    db
      .query("collectionItems")
      .withIndex("by_title", (q) => q.eq("titleId", titleId))
      .take(ROWS_PER_TITLE),
  ]);

  const rows: ReadonlyArray<{ readonly _id: Id<TitleRow> }> = [
    ...credits,
    ...episodes,
    ...seasons,
    ...genres,
    ...memberships,
  ];

  const done = rows.length === 0;

  // Out of every scan's and writer's reach from its first deletion on, so a file that returns
  // meanwhile builds a new title instead of joining one that is half gone.
  if (!done && title.purging !== true) {
    await db.patch(titleId, { purging: true, matchKey: purgingKey(titleId) });
  }

  await Promise.all(rows.map((row) => db.delete(row._id)));

  if (done) await db.delete(titleId);

  return { done, episodes: episodes.length };
};

/** Where the title stage goes next: the same page again while a title's rows remain. */
export interface TitlesNext {
  readonly cursor: string | null;
  readonly more: boolean;
}

/**
 * One page of the purge's second stage: deletes 10 of the library's titles a page that no file
 * plays any more, or that an earlier page started deleting, with their episodes, seasons,
 * credits, genre rows, and collection memberships, 200 of each a call. It pages by when each
 * title was added, which the purge never changes. Once the library is gone and its last title
 * went, its totals go too.
 */
export const titlesPage = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  cursor: string | null,
): Promise<TitlesNext> =>
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

    const orphans = await inOrder(found.page, async (title) =>
      scope.gone ||
      title.purging === true ||
      (await ctx.db
        .query("mediaFiles")
        .withIndex("by_title", (q) => q.eq("titleId", title._id))
        .first()) === null
        ? [title]
        : [],
    );

    const deleted = await inOrder(orphans.flat(), (title) => deleteTitle(ctx.db, title));
    const finished = deleted.every((one) => one.done);
    const removed = deleted.filter((one) => one.done).length;

    if (!scope.gone) {
      await moveTotals(ctx.db, libraryId, {
        ...nothingMoved,
        episodes: -deleted.reduce((sum, one) => sum + one.episodes, 0),
      });
    }

    const value: TitlesNext = !finished
      ? { cursor, more: true }
      : { cursor: found.continueCursor, more: !found.isDone };

    if (!value.more && scope.gone) await forgetTotals(ctx.db, libraryId);

    return { value, added: 0, removed };
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
