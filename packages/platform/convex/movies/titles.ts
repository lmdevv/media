import { register } from "../../commands/movies/titles";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { decidableRows, reachOf, requireItems } from "../core/permissions/grants";
import type { ItemGate } from "../core/permissions/grants";
import { movieLibraries, requireTitle, titleViewer } from "./access";
import type { TitleViewer } from "./access";
import { countGenres, rankBySimilarity, titlePage } from "./browse";
import { CREDIT_LIMIT, creditsOf } from "./credits";
import { titleFacts } from "./items";
import {
  filesOnDisk,
  presentCreditGroups,
  presentEpisode,
  presentMediaFile,
  presentProgress,
  presentTitleCard,
  presentVersion,
  resolveEpisode,
} from "./present";
import {
  continueWatching,
  findProgress,
  nextEpisodeAfter,
  presentEpisodeFor,
  upNextEpisode,
} from "./viewing";

const ROW_SCAN = 200;

const ROW_LIMIT = 20;

const CAST_LIMIT = 20;

const CREW_LIMIT = 20;

const EPISODE_CREDIT_LIMIT = 12;

const GENRE_SCAN = 1000;

const SIMILAR_SCAN = 300;

const SEARCH_SCAN = 200;

/**
 * Most episodes one season page holds: each reads its progress, up to 12 credits, and their
 * people, so a page stays far inside one call's reads.
 */
const SEASON_PAGE_MAX = 32;

const SEASONS_MAX = 200;

const CREW_ORDER = ["creator", "director", "writer", "producer", "composer"] as const;

const NO_RATINGS = { tmdb: null, imdb: null, rottenTomatoes: null, metacritic: null };

const resultLimit = (wanted: number | undefined, fallback: number, max: number): number =>
  wanted === undefined || !Number.isFinite(wanted)
    ? fallback
    : Math.min(Math.max(Math.floor(wanted), 1), max);

interface VisibleBudget {
  readonly limit: number;
  readonly scanLimit: number;
}

const firstKept = async <Item>(
  items: AsyncIterable<Item>,
  titleOf: (item: Item) => Promise<Doc<"titles"> | null>,
  keeps: TitleViewer,
  { limit, scanLimit }: VisibleBudget,
): Promise<ReadonlyArray<Doc<"titles">>> => {
  const iterator = items[Symbol.asyncIterator]();

  const fill = async (
    batch: ReadonlyArray<Item>,
    count: number,
  ): Promise<{ readonly batch: ReadonlyArray<Item>; readonly ended: boolean }> => {
    if (batch.length >= count) return { batch, ended: false };

    const step = await iterator.next();

    return step.done === true ? { batch, ended: true } : fill([...batch, step.value], count);
  };

  const take = async (
    found: ReadonlyArray<Doc<"titles">>,
    budget: number,
    size: number,
  ): Promise<ReadonlyArray<Doc<"titles">>> => {
    if (found.length >= limit || budget <= 0) return found;

    const { batch, ended } = await fill([], Math.min(size, budget));

    const titles = await Promise.all(
      batch.map(async (item) => {
        const title = await titleOf(item);

        return title !== null && (await keeps(title)) ? title : null;
      }),
    );

    const kept = [...found, ...titles.flatMap((title) => (title === null ? [] : [title]))].slice(
      0,
      limit,
    );

    return ended ? kept : take(kept, budget - batch.length, Math.max(limit * 2, 50));
  };

  try {
    return await take([], scanLimit, limit);
  } finally {
    await iterator.return?.();
  }
};

const itself = async (title: Doc<"titles">): Promise<Doc<"titles">> => title;

const admittedBy =
  (gate: ItemGate, kind: Doc<"titles">["kind"] | undefined): TitleViewer =>
  async (title) =>
    title.purging !== true &&
    (kind === undefined || title.kind === kind) &&
    gate.admits(titleFacts(title));

/** Titles read across a caller's libraries for one row or count, shared among the libraries. */
const NEWEST_READ_BUDGET = 2000;

/**
 * The `count` most recently added titles, of one kind or all, across `gates`: each library's own
 * newest that its gate admits, merged by when they were added. Each library reads its share of
 * the budget, at least `count`, so a library of titles the caller may not see cannot hide the
 * others.
 */
const newestAcross = async (
  db: DatabaseReader,
  gates: ReadonlyArray<ItemGate>,
  kind: Doc<"titles">["kind"] | undefined,
  count: number,
): Promise<ReadonlyArray<Doc<"titles">>> => {
  const scanLimit = Math.max(count, Math.floor(NEWEST_READ_BUDGET / Math.max(1, gates.length)));

  const perLibrary = await Promise.all(
    gates.map(async (gate) =>
      firstKept(
        db
          .query("titles")
          .withIndex("by_library_added", (q) => q.eq("libraryId", gate.library._id))
          .order("desc"),
        itself,
        admittedBy(gate, kind),
        { limit: count, scanLimit },
      ),
    ),
  );

  return perLibrary
    .flat()
    .toSorted((left, right) => right.addedAt - left.addedAt)
    .slice(0, count);
};

/** What one row of the title list reads besides its title: its library. */
const TITLE_ROW_READS = 2;

/** What one row reads when the list pages a genre: the genre row, its title, and its library. */
const GENRE_ROW_READS = 3;

const identityOf = (title: Doc<"titles">): ReadonlyArray<string> =>
  title.externalIds.tmdb === null ? [title._id] : [title._id, `tmdb:${title.externalIds.tmdb}`];

const namedLibrary = async (
  db: DatabaseReader,
  caller: Parameters<typeof requireItems>[1],
  libraryId: Id<"libraries">,
): Promise<void> => {
  const gate = await requireItems({ db }, caller, "view", libraryId);

  if (gate.library.kind !== "movies") fail("not_found", "No such library");
};

export const { home, list, genres, search, similar, get, versions, episodes, nextEpisode } =
  register({
    home: async (ctx, _args, caller) => {
      const reach = await reachOf(ctx.db, caller);
      const sees = titleViewer(ctx.db, caller, reach);
      const gates = await movieLibraries(ctx.db, caller);

      const [movies, shows, myList, resume] = await Promise.all([
        newestAcross(ctx.db, gates, "movie", ROW_LIMIT),
        newestAcross(ctx.db, gates, "show", ROW_LIMIT),
        firstKept(
          ctx.db
            .query("myList")
            .withIndex("by_user_added", (q) => q.eq("userId", caller.userId))
            .order("desc"),
          async (entry) => ctx.db.get(entry.titleId),
          sees,
          { limit: ROW_LIMIT, scanLimit: ROW_SCAN },
        ),
        continueWatching(ctx.db, caller.userId, sees),
      ]);

      const featured = [...movies, ...shows]
        .filter((title) => title.artwork.backdrop !== null && title.presentFileCount > 0)
        .toSorted((left, right) => right.addedAt - left.addedAt)[0];

      return {
        featured: featured === undefined ? null : presentTitleCard(featured),
        continueWatching: [...resume],
        myList: myList.map(presentTitleCard),
        recentlyAddedMovies: movies.map(presentTitleCard),
        recentlyAddedShows: shows.map(presentTitleCard),
      };
    },
    list: async (ctx, { paginationOpts, libraryId, sort, ...filter }, caller) => {
      const reach = await reachOf(ctx.db, caller);

      if (libraryId !== undefined) await namedLibrary(ctx.db, caller, libraryId);

      const page = await titlePage(
        ctx.db,
        { libraryId, kind: filter.kind },
        sort ?? "name",
        filter,
        titleViewer(ctx.db, caller, reach),
        paginationOpts,
        decidableRows(reach, filter.genre === undefined ? TITLE_ROW_READS : GENRE_ROW_READS),
      );

      return { ...page, page: page.page.map(presentTitleCard) };
    },
    genres: async (ctx, { kind }, caller) => {
      const gates = await movieLibraries(ctx.db, caller);

      return [...countGenres(await newestAcross(ctx.db, gates, kind, GENRE_SCAN))];
    },
    search: async (ctx, { query: typed, limit }, caller) => {
      const text = typed.trim();

      if (text.length === 0) return [];

      const sees = titleViewer(ctx.db, caller, await reachOf(ctx.db, caller));

      const matches = await firstKept(
        ctx.db.query("titles").withSearchIndex("search_text", (q) => q.search("searchText", text)),
        itself,
        sees,
        { limit: resultLimit(limit, 20, 50), scanLimit: SEARCH_SCAN },
      );

      return matches.map(presentTitleCard);
    },
    similar: async (ctx, { titleId, limit }, caller) => {
      const { title, reach } = await requireTitle(ctx.db, caller, "view", titleId);
      const sees = titleViewer(ctx.db, caller, reach);
      const wanted = resultLimit(limit, ROW_LIMIT, 50);

      const recommended = await Promise.all(
        (title.recommendations ?? []).map(async (tmdb) => {
          const matches = await ctx.db
            .query("titles")
            .withIndex("by_kind_tmdb", (q) => q.eq("kind", title.kind).eq("externalIds.tmdb", tmdb))
            .take(5);

          const visible = await Promise.all(
            matches.map(async (match) => match._id !== title._id && (await sees(match))),
          );

          return matches.find((_, index) => visible[index] === true);
        }),
      );

      const seen = new Set<string>(identityOf(title));

      const fresh = (candidate: Doc<"titles">): boolean => {
        const keys = identityOf(candidate);

        if (keys.some((key) => seen.has(key))) return false;

        for (const key of keys) seen.add(key);

        return true;
      };

      const chosen = recommended.flatMap((match) =>
        match === undefined || !fresh(match) ? [] : [match],
      );

      const topUp =
        chosen.length >= wanted
          ? []
          : rankBySimilarity(
              title,
              await newestAcross(
                ctx.db,
                await movieLibraries(ctx.db, caller),
                title.kind,
                SIMILAR_SCAN,
              ),
            ).filter(fresh);

      return [...chosen, ...topUp].slice(0, wanted).map(presentTitleCard);
    },
    get: async (ctx, { titleId }, caller) => {
      const { title } = await requireTitle(ctx.db, caller, "view", titleId);
      const { userId } = caller;
      const movie = title.kind === "movie";

      const [seasons, files, progress, next, listed, rows, memberships] = await Promise.all([
        ctx.db
          .query("seasons")
          .withIndex("by_title_number", (q) => q.eq("titleId", titleId))
          .take(SEASONS_MAX),
        movie ? filesOnDisk(ctx.db, title, null) : [],
        movie ? findProgress(ctx.db, userId, titleId, null) : null,
        movie ? null : upNextEpisode(ctx.db, userId, titleId),
        ctx.db
          .query("myList")
          .withIndex("by_user_title", (q) => q.eq("userId", userId).eq("titleId", titleId))
          .unique(),
        creditsOf(ctx.db, titleId, null, CREDIT_LIMIT),
        ctx.db
          .query("collectionItems")
          .withIndex("by_title", (q) => q.eq("titleId", titleId))
          .take(20),
      ]);

      const castRows = rows.filter((row) => row.kind === "actor").slice(0, CAST_LIMIT);

      const crewRows = CREW_ORDER.flatMap((kind) => rows.filter((row) => row.kind === kind)).slice(
        0,
        CREW_LIMIT,
      );

      const membership =
        memberships.find((member) => member.source === "metadata") ?? memberships[0];

      const [[cast = [], crew = []], collection, upNext] = await Promise.all([
        presentCreditGroups(ctx.db, [castRows, crewRows]),
        membership === undefined ? null : ctx.db.get(membership.collectionId),
        next === null ? null : presentEpisodeFor(ctx.db, userId, next),
      ]);

      return {
        ...presentTitleCard(title),
        libraryId: title.libraryId,
        sortName: title.overrides?.sortName ?? title.sortName,
        overview: title.overrides?.overview ?? title.overview,
        tagline: title.tagline,
        externalIds: title.externalIds,
        matchStatus: title.matchStatus,
        originalName: title.originalName ?? null,
        releaseDate: title.releaseDate ?? null,
        status: title.status ?? null,
        originalLanguage: title.originalLanguage ?? null,
        studios: title.studios ?? [],
        countries: title.countries ?? [],
        tags: title.tags ?? [],
        ratings: title.ratings ?? NO_RATINGS,
        trailer: title.trailer ?? null,
        collection: collection === null ? null : { id: collection._id, name: collection.name },
        cast: [...cast],
        crew: [...crew],
        seasons: seasons.map((season) => ({
          id: season._id,
          seasonNumber: season.seasonNumber,
          name: season.name,
          poster: season.poster,
          episodeCount: season.episodeCount,
          externalIds: season.externalIds,
        })),
        files: files.map(presentMediaFile),
        versions: files.map((file) => presentVersion(file, progress?.fileId ?? null)),
        progress: progress === null ? null : presentProgress(progress),
        nextEpisode: upNext,
        inMyList: listed !== null,
      };
    },
    versions: async (ctx, { titleId, episodeId }, caller) => {
      const { title } = await requireTitle(ctx.db, caller, "view", titleId);
      const episode = await resolveEpisode(ctx.db, title, episodeId ?? null);

      const [files, progress] = await Promise.all([
        filesOnDisk(ctx.db, title, episode),
        findProgress(ctx.db, caller.userId, titleId, episode?._id ?? null),
      ]);

      return files.map((file) => presentVersion(file, progress?.fileId ?? null));
    },
    episodes: async (ctx, { titleId, seasonNumber, paginationOpts }, caller) => {
      await requireTitle(ctx.db, caller, "view", titleId);

      const page = await paginateAtMost(
        ctx.db,
        {
          table: "episodes",
          index: "by_title_order",
          range: (q) => q.eq("titleId", titleId).eq("seasonNumber", seasonNumber),
        },
        paginationOpts,
        SEASON_PAGE_MAX,
      );

      const [watches, rows] = await Promise.all([
        Promise.all(
          page.page.map(async (doc) => findProgress(ctx.db, caller.userId, titleId, doc._id)),
        ),
        Promise.all(
          page.page.map(async (doc) => creditsOf(ctx.db, titleId, doc._id, EPISODE_CREDIT_LIMIT)),
        ),
      ]);

      const credits = await presentCreditGroups(ctx.db, rows);

      return {
        ...page,
        page: page.page.map((doc, index) =>
          Object.assign(presentEpisode(doc, watches[index] ?? null), {
            credits: [...(credits[index] ?? [])],
          }),
        ),
      };
    },
    nextEpisode: async (ctx, { episodeId }, caller) => {
      const current = await ctx.db.get(episodeId);

      if (current === null) return fail("not_found", "No such episode");

      await requireTitle(ctx.db, caller, "view", current.titleId);

      const next = await nextEpisodeAfter(ctx.db, current);

      return next === null ? null : presentEpisodeFor(ctx.db, caller.userId, next);
    },
  });
