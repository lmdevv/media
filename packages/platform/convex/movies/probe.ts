import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { level } from "../../commands/access";
import { callerScope } from "../../commands/scopes";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { callerOfSession } from "../core/auth/caller";
import { claimFolders } from "../core/folders";
import { jobPayload } from "../core/jobs/kinds";
import { cancel, enqueue } from "../core/jobs/queue";
import { fail } from "../core/lib/errors";
import { inOrder } from "../core/lib/inOrder";
import { paginate } from "../core/lib/paginate";
import { grantCreator, requireItems } from "../core/permissions/grants";
import { contentActions } from "../core/permissions/policy";
import { withLibraryItems } from "../core/scans";
import { NO_EXTERNAL_IDS } from "./catalog";
import { titleFacts } from "./items";
import { CALL_BUDGET, work } from "./budget";
import { askForMatch, askForRefresh } from "./matching";
import { filesPage, titlesPage } from "./purge";
import { moveTotals, nothingMoved, totalsOf } from "./totals";
import { trickplayState } from "./validators";

/**
 * The stack suite's seam into the movies catalog, as `core/libraryProbe.ts` is for music until
 * the music port: a seed of rated titles written without a scan, and `open` and `page`, which
 * decide titles through `requireItems` as the movies commands will. The server never calls it.
 */

const SEED_MAX = 200;

const EMPTY_PROBE = {
  container: "matroska",
  durationMs: 0,
  bitRate: null,
  video: [],
  audio: [],
  subtitles: [],
};

const seededTitle = v.object({
  name: v.string(),
  /** The minimum viewer age, or null for unrated. */
  age: v.union(v.number(), v.null()),
  /** A show's episode count, each with a file; a movie has none and one file. */
  episodes: v.number(),
});

const seededRows = v.object({
  titleId: v.id("titles"),
  fileIds: v.array(v.id("mediaFiles")),
  episodeIds: v.array(v.id("episodes")),
});

const insertTitle = async (
  db: MutationCtx["db"],
  libraryId: Id<"libraries">,
  folder: string,
  title: { readonly name: string; readonly age: number | null; readonly episodes: number },
) => {
  const now = Date.now();
  const kind = title.episodes > 0 ? "show" : "movie";
  const sortKey = title.name.toLowerCase();

  const titleId = await db.insert("titles", {
    libraryId,
    kind,
    matchKey: `seed:${title.name}`,
    name: title.name,
    sortName: title.name,
    sortKey,
    year: null,
    overview: null,
    tagline: null,
    genres: [],
    certification: null,
    ageRating: title.age,
    runtimeMs: null,
    artwork: { poster: null, backdrop: null, logo: null },
    externalIds: NO_EXTERNAL_IDS,
    matchStatus: "unmatched",
    presentFileCount: Math.max(title.episodes, 1),
    episodeCount: title.episodes,
    matchGeneration: 0,
    addedAt: now,
    updatedAt: now,
    searchText: title.name,
  });

  const seasonId =
    title.episodes > 0
      ? await db.insert("seasons", {
          titleId,
          seasonNumber: 1,
          name: "Season 1",
          poster: null,
          episodeCount: title.episodes,
          externalIds: NO_EXTERNAL_IDS,
        })
      : null;

  const episodeIds =
    seasonId === null
      ? []
      : await inOrder(
          Array.from({ length: title.episodes }, (_, n) => n + 1),
          async (episodeNumber) =>
            db.insert("episodes", {
              titleId,
              seasonId,
              seasonNumber: 1,
              episodeNumber,
              name: `Episode ${episodeNumber}`,
              overview: null,
              airDate: null,
              runtimeMs: null,
              still: null,
              presentFileCount: 1,
              rating: null,
              externalIds: NO_EXTERNAL_IDS,
            }),
        );

  const fileIds = await inOrder(episodeIds.length === 0 ? [null] : episodeIds, async (episodeId) =>
    db.insert("mediaFiles", {
      libraryId,
      titleId,
      episodeId,
      path: `${folder}/${title.name}/${episodeId ?? "movie"}.mkv`,
      sizeBytes: 1_000_000,
      mtimeMs: 0,
      probe: EMPTY_PROBE,
      externalSubtitles: [],
      versionName: null,
      hdr: false,
      missing: false,
      addedAt: now,
      sidecarDigest: null,
    }),
  );

  return { titleId, fileIds: [...fileIds], episodeIds: [...episodeIds] };
};

/**
 * Makes movies libraries managed by `managerId`, each with a folder of its own and rated titles in
 * it, and queues no scan. A title with episodes is a show of one season.
 *
 * @throws Error when asked for none or more than 200 libraries.
 */
export const seed = internalMutation({
  args: {
    managerId: v.id("users"),
    libraries: v.array(v.object({ name: v.string(), titles: v.array(seededTitle) })),
  },
  returns: v.array(v.object({ libraryId: v.id("libraries"), titles: v.array(seededRows) })),
  handler: async (ctx, { managerId, libraries }) => {
    if (libraries.length === 0 || libraries.length > SEED_MAX) {
      throw new Error(`seed makes 1 to ${SEED_MAX} libraries; got ${libraries.length}`);
    }

    const seeded = await inOrder(libraries, async ({ name, titles }) => {
      const libraryId = await ctx.db.insert("libraries", { name, kind: "movies", lastScan: null });
      const folder = `/probe/${libraryId}`;

      await claimFolders(ctx, libraryId, [folder]);
      await grantCreator(ctx, { type: "library", id: libraryId }, managerId);

      const rows = await withLibraryItems(ctx, libraryId, async () => {
        const inserted = await inOrder(titles, (title) =>
          insertTitle(ctx.db, libraryId, folder, title),
        );

        return { value: inserted, added: inserted.length, removed: 0 };
      });

      await moveTotals(ctx.db, libraryId, {
        ...nothingMoved,
        episodes: rows.reduce((sum, row) => sum + row.episodeIds.length, 0),
        files: rows.reduce((sum, row) => sum + row.fileIds.length, 0),
      });

      return { libraryId, titles: [...rows] };
    });

    return [...seeded];
  },
});

const opened = v.object({ titleId: v.id("titles"), name: v.string(), level });

/** Opens a title as a session would through a command that declares `scope`. */
export const open = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    action: v.union(...contentActions.map((action) => v.literal(action))),
    titleId: v.id("titles"),
  },
  returns: opened,
  handler: async (ctx, { sessionId, scope, action, titleId }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const found = await ctx.db.get(titleId);

    const title =
      found === null || found.purging === true ? fail("not_found", "No such title") : found;

    const gate = await requireItems(ctx, caller, action, title.libraryId);

    if (!gate.admits(titleFacts(title))) fail("not_found", "No such title");

    return { titleId: title._id, name: title.name, level: gate.level };
  },
});

/** One page of a library's titles a session sees, by sort key, as a title list would page them. */
export const page = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    libraryId: v.id("libraries"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(opened),
  handler: async (ctx, { sessionId, scope, libraryId, paginationOpts }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const gate = await requireItems(ctx, caller, "view", libraryId);

    const found = await paginate(
      ctx.db,
      {
        table: "titles",
        index: "by_library_sort",
        range: (q) => q.eq("libraryId", libraryId),
      },
      paginationOpts,
    );

    return {
      ...found,
      page: found.page
        .filter((title) => title.purging !== true && gate.admits(titleFacts(title)))
        .map((title) => ({ titleId: title._id, name: title.name, level: gate.level })),
    };
  },
});

const counted = v.object({ titles: v.number(), episodes: v.number(), files: v.number() });

/** A library's totals as its counters hold them. */
export const totals = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: counted,
  handler: (ctx, { libraryId }) => totalsOf(ctx.db, libraryId),
});

const ROWS_PAGE = 100;

/**
 * One page of a library's live rows counted the slow way, from `cursor` over its titles: the
 * titles the purge is not deleting, their episodes, and the library's files under them, for a
 * test to compare with `totals`.
 */
export const rows = internalQuery({
  args: { libraryId: v.id("libraries"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ counted, continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { libraryId, cursor }) => {
    const found = await paginate(
      ctx.db,
      {
        table: "titles",
        index: "by_library_match",
        range: (q) => q.eq("libraryId", libraryId),
      },
      { numItems: ROWS_PAGE, cursor },
    );

    const live = found.page.filter((title) => title.purging !== true);

    const perTitle = await Promise.all(
      live.map(async (title) => {
        const [episodes, files] = await Promise.all([
          ctx.db
            .query("episodes")
            .withIndex("by_title_order", (q) => q.eq("titleId", title._id))
            .collect(),
          ctx.db
            .query("mediaFiles")
            .withIndex("by_title", (q) => q.eq("titleId", title._id))
            .collect(),
        ]);

        return { episodes: episodes.length, files: files.length };
      }),
    );

    return {
      counted: {
        titles: live.length,
        episodes: perTitle.reduce((sum, one) => sum + one.episodes, 0),
        files: perTitle.reduce((sum, one) => sum + one.files, 0),
      },
      continueCursor: found.continueCursor,
      isDone: found.isDone,
    };
  },
});

/** Whether any movies row of `libraryId` is left: a title or a file. */
export const hasRows = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.boolean(),
  handler: async (ctx, { libraryId }) => {
    const [title, file] = await Promise.all([
      ctx.db
        .query("titles")
        .withIndex("by_library_match", (q) => q.eq("libraryId", libraryId))
        .first(),
      ctx.db
        .query("mediaFiles")
        .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
        .first(),
    ]);

    return title !== null || file !== null;
  },
});

/** Up to 1,000 of a library's files with their paths, for a test to name files it scanned. */
export const files = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.array(v.object({ fileId: v.id("mediaFiles"), path: v.string() })),
  handler: async (ctx, { libraryId }) => {
    const found = await ctx.db
      .query("mediaFiles")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .take(1000);

    return found.map((file) => ({ fileId: file._id, path: file.path }));
  },
});

/** Asks for an admin's match of a title, as the movies command will (`askForMatch`). */
export const askMatch = internalMutation({
  args: { titleId: v.id("titles"), providerId: v.string() },
  returns: v.id("jobs"),
  handler: async (ctx, { titleId, providerId }) => {
    const title = (await ctx.db.get(titleId)) ?? fail("not_found", "No such title");

    return askForMatch(ctx, title, { provider: "tmdb", providerId });
  },
});

/** Asks for a refresh of a title's metadata, as the movies command will (`askForRefresh`). */
export const askRefresh = internalMutation({
  args: { titleId: v.id("titles") },
  returns: v.id("jobs"),
  handler: async (ctx, { titleId }) =>
    askForRefresh(ctx, (await ctx.db.get(titleId)) ?? fail("not_found", "No such title")),
});

/** Queues a job as a movies command will, such as an admin's metadata refresh. */
export const enqueueJob = internalMutation({
  args: { payload: jobPayload },
  returns: v.id("jobs"),
  handler: async (ctx, { payload }) => (await enqueue(ctx, payload)).jobId,
});

/** Whether any shard of the library's episode or file totals is left. */
export const hasTotals = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.boolean(),
  handler: async (ctx, { libraryId }) => {
    const shards = await Promise.all(
      [`movies.episodes:${libraryId}`, `movies.files:${libraryId}`].map(async (name) =>
        ctx.db
          .query("counters")
          .withIndex("by_name_shard", (q) => q.eq("name", name))
          .first(),
      ),
    );

    return shards.some((shard) => shard !== null);
  },
});

/** A file's scrub-thumbnail state, for a test to find the job a scan queued. */
export const fileState = internalQuery({
  args: { fileId: v.id("mediaFiles") },
  returns: v.object({ trickplay: v.union(trickplayState, v.null()) }),
  handler: async (ctx, { fileId }) => {
    const file = (await ctx.db.get(fileId)) ?? fail("not_found", "No such file");

    return { trickplay: file.trickplay ?? null };
  },
});

const CANCEL_BATCH = 500;

/**
 * Cancels up to 500 queued jobs of a movies kind, so a test that queued many, such as a scan's
 * scrub thumbnails, leaves the queue as it found it. Says whether queued jobs remain.
 */
export const cancelQueued = internalMutation({
  args: {
    kind: v.union(
      v.literal("movies.scan"),
      v.literal("movies.metadata"),
      v.literal("movies.person"),
      v.literal("movies.trickplay"),
    ),
  },
  returns: v.object({ more: v.boolean() }),
  handler: async (ctx, { kind }) => {
    const queued = await ctx.db
      .query("jobs")
      .withIndex("by_kind_status", (q) => q.eq("payload.kind", kind).eq("status", "queued"))
      .take(CANCEL_BATCH);

    await inOrder(queued, (job) => cancel(ctx, job._id));

    return { more: queued.length === CANCEL_BATCH };
  },
});

/**
 * Makes `folders` the library's folders without scheduling its purge, so a test can run the
 * purge one page at a time with `purgePage` and act between pages.
 */
export const setFolders = internalMutation({
  args: { libraryId: v.id("libraries"), folders: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { libraryId, folders }) => {
    await claimFolders(ctx, libraryId, folders);

    return null;
  },
});

/** Runs one page of the movies purge's `files` or `titles` stage, and schedules nothing. */
export const purgePage = internalMutation({
  args: {
    libraryId: v.id("libraries"),
    stage: v.union(v.literal("files"), v.literal("titles")),
    cursor: v.union(v.string(), v.null()),
    /** A smaller budget of index ranges than a call's, so a test can stop a page partway. */
    ranges: v.optional(v.number()),
  },
  returns: v.object({ cursor: v.union(v.string(), v.null()), more: v.boolean() }),
  handler: async (ctx, { libraryId, stage, cursor, ranges }) => {
    const limit = ranges === undefined ? CALL_BUDGET : work(ranges, CALL_BUDGET.writes);

    return stage === "titles"
      ? titlesPage(ctx, libraryId, cursor, limit)
      : filesPage(ctx, libraryId, cursor, limit);
  },
});

const TITLE_ROWS_MAX = 1000;

/**
 * A title as a test checks it after a purge, or null once it is gone: whether the purge is
 * deleting it, its rows, and whether every episode's season exists and counts it.
 */
export const titleState = internalQuery({
  args: { titleId: v.id("titles") },
  returns: v.union(
    v.null(),
    v.object({
      purging: v.boolean(),
      episodes: v.number(),
      seasons: v.number(),
      genres: v.number(),
      seasonsHoldEpisodes: v.boolean(),
    }),
  ),
  handler: async (ctx, { titleId }) => {
    const title = await ctx.db.get(titleId);

    if (title === null) return null;

    const [episodes, seasons, genres] = await Promise.all([
      ctx.db
        .query("episodes")
        .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
        .take(TITLE_ROWS_MAX),
      ctx.db
        .query("seasons")
        .withIndex("by_title_number", (q) => q.eq("titleId", titleId))
        .take(TITLE_ROWS_MAX),
      ctx.db
        .query("titleGenres")
        .withIndex("by_title", (q) => q.eq("titleId", titleId))
        .take(TITLE_ROWS_MAX),
    ]);

    const seasonIds = new Set(seasons.map((season) => season._id));
    const seasonCounts = seasons.reduce((sum, season) => sum + season.episodeCount, 0);

    return {
      purging: title.purging === true,
      episodes: episodes.length,
      seasons: seasons.length,
      genres: genres.length,
      seasonsHoldEpisodes:
        episodes.every((episode) => seasonIds.has(episode.seasonId)) &&
        seasonCounts === episodes.length,
    };
  },
});

/**
 * What a title's metadata writers stored for it, for a test to read back: the names of the people
 * credited on the title itself, in billing order, and each collection it is in.
 */
export const titleLinks = internalQuery({
  args: { titleId: v.id("titles") },
  returns: v.object({
    credited: v.array(v.string()),
    collections: v.array(
      v.object({
        sourceKey: v.union(v.string(), v.null()),
        name: v.string(),
        source: v.union(v.literal("metadata"), v.literal("import")),
      }),
    ),
  }),
  handler: async (ctx, { titleId }) => {
    const [credits, memberships] = await Promise.all([
      ctx.db
        .query("credits")
        .withIndex("by_title_episode", (q) => q.eq("titleId", titleId).eq("episodeId", null))
        .take(TITLE_ROWS_MAX),
      ctx.db
        .query("collectionItems")
        .withIndex("by_title", (q) => q.eq("titleId", titleId))
        .take(TITLE_ROWS_MAX),
    ]);

    const people = await Promise.all(credits.map(async (credit) => ctx.db.get(credit.personId)));

    const collections = await Promise.all(
      memberships.map(async (row) => ctx.db.get(row.collectionId)),
    );

    return {
      credited: people.flatMap((person) => (person === null ? [] : [person.name])),
      collections: memberships.flatMap((row, n) => {
        const collection = collections[n];

        return collection === null || collection === undefined
          ? []
          : [{ sourceKey: collection.sourceKey, name: collection.name, source: row.source }];
      }),
    };
  },
});
