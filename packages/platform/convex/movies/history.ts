import { v } from "convex/values";

import { register } from "../../commands/movies/history";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginate, paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { principalOf } from "../core/permissions/policy";
import { mayActOnTitle, requireTitle, titleViewer } from "./access";
import { CALL_BUDGET, work } from "./budget";
import { presentEpisode, presentProgress, presentTitleCard } from "./present";
import { continueWatching as continueWatchingOf, findProgress, writeProgress } from "./viewing";

const HISTORY_PAGE_MAX = 200;

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
 * the person who asked. It stops once the title is gone or being purged, or the person may no
 * longer play it.
 */
export const markRest = internalMutation({
  args: {
    userId: v.id("users"),
    titleId: v.id("titles"),
    watched: v.boolean(),
    at: v.number(),
    cursor: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { userId, titleId, watched, at, cursor }) => {
    const [title, user] = await Promise.all([ctx.db.get(titleId), ctx.db.get(userId)]);

    const allowed =
      title !== null &&
      user !== null &&
      (await mayActOnTitle(ctx.db, principalOf(user), "play", titleId));

    if (allowed) await markShowPage(ctx, { userId, title, watched, at }, cursor);

    return null;
  },
});

export const { continueWatching, list, markWatched, markUnwatched } = register({
  continueWatching: async (ctx, _args, caller) => {
    const sees = titleViewer(ctx.db, caller, await reachOf(ctx.db, caller));

    return [...(await continueWatchingOf(ctx.db, caller.userId, sees))];
  },
  list: async (ctx, { paginationOpts }, caller) => {
    const sees = titleViewer(ctx.db, caller, await reachOf(ctx.db, caller));

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "watchProgress",
        index: "by_user_played",
        range: (q) => q.eq("userId", caller.userId),
        order: "desc",
      },
      paginationOpts,
      HISTORY_PAGE_MAX,
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

    await markTarget(
      ctx,
      { userId: caller.userId, title, watched: true, at: Date.now() },
      episodeId,
    );

    return null;
  },
  markUnwatched: async (ctx, { titleId, episodeId }, caller) => {
    const { title } = await requireTitle(ctx.db, caller, "play", titleId);

    await markTarget(
      ctx,
      { userId: caller.userId, title, watched: false, at: Date.now() },
      episodeId,
    );

    return null;
  },
});
