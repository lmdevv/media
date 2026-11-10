import { v } from "convex/values";

import { register } from "../../commands/movies/history";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginate, paginateAtMost } from "../core/lib/paginate";
import { decidableRows, reachOf } from "../core/permissions/grants";
import { principalOf } from "../core/permissions/policy";
import { budgetedViewer, mayActOnTitle, requireTitle, titleViewer } from "./access";
import { CALL_BUDGET, work } from "./budget";
import { presentEpisode, presentProgress, presentTitleCard } from "./present";
import { callBudget } from "./reads";
import {
  continueWatching as continueWatchingOf,
  findProgress,
  nextWatchGeneration,
  watchGeneration,
  writeProgress,
} from "./viewing";

const HISTORY_PAGE_MAX = 200;

/** What one history row reads besides its grant checks: the row, its title, episode, and library. */
const HISTORY_ROW_READS = 4;

/** Marking one episode: its progress row read (1 range), then written or deleted (1, 1). */
const MARK_COST = work(2, 1);

/**
 * Episodes one call marks for a whole show: as many as the call budget admits at each one's worst
 * case (ADR 0013), at most 500. A longer show takes several calls, the rest scheduled in pages.
 */
const MARK_PAGE = Math.min(
  500,
  Math.floor(CALL_BUDGET.ranges / MARK_COST.ranges),
  Math.floor(CALL_BUDGET.writes / MARK_COST.writes),
);

type Ctx = Pick<MutationCtx, "db" | "scheduler">;

interface Mark {
  readonly userId: Id<"users">;
  readonly title: Doc<"titles">;
  readonly watched: boolean;
  readonly at: number;
  /** The person's history generation of the title this change moved it to (`viewing.ts`). */
  readonly generation: number;
}

const markOne = async (ctx: Ctx, mark: Mark, episode: Doc<"episodes"> | null): Promise<void> => {
  const { userId, title } = mark;
  const episodeId = episode?._id ?? null;

  if (!mark.watched) {
    const row = await findProgress(ctx.db, userId, title._id, episodeId);

    if (row !== null) await ctx.db.delete(row._id);

    return;
  }

  const durationMs = episode?.runtimeMs ?? title.runtimeMs ?? 0;

  await writeProgress(ctx, {
    userId,
    titleId: title._id,
    episodeId,
    fileId: null,
    positionMs: durationMs,
    durationMs,
    watched: true,
    playedAt: mark.at,
    origin: null,
  });
};

const markShowPage = async (ctx: Ctx, mark: Mark, cursor: string | null): Promise<void> => {
  const page = await paginate(
    ctx.db,
    { table: "episodes", index: "by_title_order", range: (q) => q.eq("titleId", mark.title._id) },
    { numItems: MARK_PAGE, cursor },
  );

  await Promise.all(page.page.map(async (episode) => markOne(ctx, mark, episode)));

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.movies.history.markRest, {
      userId: mark.userId,
      titleId: mark.title._id,
      watched: mark.watched,
      at: mark.at,
      generation: mark.generation,
      cursor: page.continueCursor,
    });
  }
};

const markTarget = async (
  ctx: Ctx,
  mark: Mark,
  episodeId: Id<"episodes"> | undefined,
): Promise<void> => {
  if (mark.title.kind === "movie") return markOne(ctx, mark, null);

  if (episodeId === undefined) return markShowPage(ctx, mark, null);

  const episode = await ctx.db.get(episodeId);

  return episode?.titleId === mark.title._id
    ? markOne(ctx, mark, episode)
    : fail("not_found", "No such episode");
};

/**
 * Marks the next page of a show that `movies.history.markWatched` or `markUnwatched` started, as
 * the person who asked. It stops once the title is gone or being purged, the person may no longer
 * play it, or a newer change of their history of the title (a mark or a progress report) moved its
 * generation past this one's, so a superseded page writes nothing.
 */
export const markRest = internalMutation({
  args: {
    userId: v.id("users"),
    titleId: v.id("titles"),
    watched: v.boolean(),
    at: v.number(),
    generation: v.number(),
    cursor: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { userId, titleId, watched, at, generation, cursor }) => {
    const [title, user, current] = await Promise.all([
      ctx.db.get(titleId),
      ctx.db.get(userId),
      watchGeneration(ctx.db, userId, titleId),
    ]);

    const allowed =
      current === generation &&
      title !== null &&
      user !== null &&
      (await mayActOnTitle(ctx.db, principalOf(user), "play", titleId));

    if (allowed) await markShowPage(ctx, { userId, title, watched, at, generation }, cursor);

    return null;
  },
});

export const { continueWatching, list, markWatched, markUnwatched } = register({
  continueWatching: async (ctx, _args, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);
    const seen = budgetedViewer(ctx.db, caller, reach, budget);

    return [...(await continueWatchingOf(ctx.db, caller.userId, seen, budget))];
  },
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const sees = titleViewer(ctx.db, caller, reach);

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "watchProgress",
        index: "by_user_played",
        range: (q) => q.eq("userId", caller.userId),
        order: "desc",
      },
      paginationOpts,
      Math.min(HISTORY_PAGE_MAX, decidableRows(reach, HISTORY_ROW_READS)),
    );

    const entries = await Promise.all(
      page.page.map(async (row) => {
        const title = await ctx.db.get(row.titleId);

        if (title === null || !(await sees(title))) return [];

        const episode = row.episodeId === null ? null : await ctx.db.get(row.episodeId);

        return [
          {
            title: presentTitleCard(title),
            episode: episode === null ? null : presentEpisode(episode, row),
            progress: presentProgress(row),
            lastPlayedAt: row.lastPlayedAt,
          },
        ];
      }),
    );

    return { ...page, page: entries.flat() };
  },
  markWatched: async (ctx, { titleId, episodeId }, caller) => {
    const { title } = await requireTitle(ctx.db, caller, "play", titleId);

    const at = Date.now();
    const whole = episodeId === undefined ? at : undefined;
    const generation = await nextWatchGeneration(ctx, caller.userId, titleId, whole);

    await markTarget(
      ctx,
      { userId: caller.userId, title, watched: true, at, generation },
      episodeId,
    );

    return null;
  },
  markUnwatched: async (ctx, { titleId, episodeId }, caller) => {
    const { title } = await requireTitle(ctx.db, caller, "play", titleId);

    const at = Date.now();
    const whole = episodeId === undefined ? at : undefined;
    const generation = await nextWatchGeneration(ctx, caller.userId, titleId, whole);

    await markTarget(
      ctx,
      { userId: caller.userId, title, watched: false, at, generation },
      episodeId,
    );

    return null;
  },
});
