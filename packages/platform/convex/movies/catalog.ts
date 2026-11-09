import { compareValues } from "convex/values";
import type { Infer, Value } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import type { JobCtx } from "../core/jobs/store";
import { addWork, work } from "./budget";
import type { Work } from "./budget";
import { nothingMoved } from "./totals";
import type { Moved } from "./totals";
import { forgetTrickplay, queueTrickplay } from "./trickplayState";
import type { scannedEpisode, scannedItem, scannedTitle, upsertedFile } from "./validators";

type Db = MutationCtx["db"];

type ScannedTitle = Infer<typeof scannedTitle>;

type ExternalIds = Doc<"titles">["externalIds"];

export const NO_EXTERNAL_IDS: ExternalIds = { tmdb: null, imdb: null, tvdb: null };

/** Most studios, countries, or recommendations a title keeps. */
const TITLE_LIST_LIMIT = 20;

/**
 * Most distinct genres a title keeps, far above any real file: old movies kept every NFO
 * `<genre>`, and so does this, up to here (ADR 0024). It exists only so one title's worst case
 * always fits one call's budget, since each genre is a `titleGenres` row; a title with more keeps
 * its first 256 and the batch goes on.
 */
const GENRES_HARD_MAX = 256;

/** Most keywords a title keeps. */
const TITLE_TAG_LIMIT = 40;

/** The shape of a YouTube video id. */
const YOUTUBE_KEY = /^[\w-]{6,20}$/u;

/**
 * Whether any of `fields` differs from the same key of `doc`, compared as Convex compares values.
 * A write that changes nothing still costs a document write and wakes every query that read the
 * row, so a rescan checks first.
 */
const changesAny = (
  doc: Readonly<Record<string, Value | undefined>>,
  fields: Readonly<Record<string, Value | undefined>>,
): boolean =>
  Object.entries(fields).some(([key, value]) => {
    const stored = doc[key];

    return stored === undefined || value === undefined
      ? stored !== value
      : compareValues(stored, value) !== 0;
  });

interface Named {
  readonly name: string;
  readonly sortName: string;
  readonly year: number | null;
  readonly overrides?: { readonly name?: string; readonly sortName?: string } | undefined;
}

const searchTextOf = (title: Named): string =>
  [
    title.overrides?.name,
    title.name,
    title.sortName === title.name ? undefined : title.sortName,
    title.year,
  ]
    .filter((part) => part !== undefined && part !== null)
    .join(" ");

/**
 * The key title lists sort by: a sort name an admin set wins over the scanned one. A name override
 * alone leaves the order as scanned, so fixing a typo in "Teh Matrix" keeps it under M.
 */
const sortKeyOf = (title: Named): string => {
  const override = title.overrides?.sortName?.trim();

  return (override === undefined || override === "" ? title.sortName : override).toLowerCase();
};

/** A genre as rows store it and filters compare it. */
const genreKey = (genre: string): string => genre.trim().toLowerCase();

/** A title's genres as it keeps them: the first `GENRES_HARD_MAX` distinct ones, in order. */
const keptGenres = (genres: ReadonlyArray<string>): Array<string> => {
  const seen = new Set<string>();

  return genres.filter((genre) => {
    const key = genreKey(genre);

    if (key === "" || seen.has(key) || seen.size >= GENRES_HARD_MAX) return false;

    seen.add(key);

    return true;
  });
};

/** How many genre rows a title keeps for `genres`. */
const genreRows = (genres: ReadonlyArray<string>): number => keptGenres(genres).length;

/** Makes the title's genre rows match its current genres and sort fields. */
const syncTitleGenres = async (db: Db, title: Doc<"titles">): Promise<void> => {
  // Every write of a title's genres goes through here and keeps at most GENRES_HARD_MAX rows.
  const rows = await db
    .query("titleGenres")
    .withIndex("by_title", (q) => q.eq("titleId", title._id))
    .take(GENRES_HARD_MAX);

  const wanted = new Set(keptGenres(title.genres).map(genreKey));

  const fields = {
    libraryId: title.libraryId,
    kind: title.kind,
    sortKey: title.sortKey,
    addedAt: title.addedAt,
    year: title.year,
  };

  const kept = new Set<string>();

  await Promise.all(
    rows.map(async (row) => {
      if (!wanted.has(row.genre) || kept.has(row.genre)) return db.delete(row._id);

      kept.add(row.genre);

      return changesAny(row, fields) ? db.patch(row._id, fields) : undefined;
    }),
  );

  await Promise.all(
    [...wanted].flatMap((genre) =>
      kept.has(genre) ? [] : [db.insert("titleGenres", { titleId: title._id, genre, ...fields })],
    ),
  );
};

/**
 * The key a title takes once the purge starts deleting it: its own id, which no scanned key can
 * be, so no scan or metadata job finds it by its old key again (ADR 0024).
 */
export const purgingKey = (titleId: Id<"titles">): string => `purging:${titleId}`;

const checkedTrailer = (value: ScannedTitle["trailer"]) =>
  value === undefined || value === null || YOUTUBE_KEY.test(value.key) ? value : null;

type RichMetadata = Partial<
  Pick<
    Doc<"titles">,
    | "originalName"
    | "releaseDate"
    | "status"
    | "originalLanguage"
    | "studios"
    | "countries"
    | "tags"
    | "ratings"
    | "trailer"
    | "recommendations"
  >
>;

const richMetadata = (scanned: ScannedTitle): RichMetadata => {
  const rich: RichMetadata = {};
  const checked = checkedTrailer(scanned.trailer);

  if (scanned.originalName !== undefined) rich.originalName = scanned.originalName;

  if (scanned.releaseDate !== undefined) rich.releaseDate = scanned.releaseDate;

  if (scanned.status !== undefined) rich.status = scanned.status;

  if (scanned.originalLanguage !== undefined) rich.originalLanguage = scanned.originalLanguage;

  if (scanned.studios !== undefined) rich.studios = scanned.studios.slice(0, TITLE_LIST_LIMIT);

  if (scanned.countries !== undefined) {
    rich.countries = scanned.countries.slice(0, TITLE_LIST_LIMIT);
  }

  if (scanned.tags !== undefined) rich.tags = scanned.tags.slice(0, TITLE_TAG_LIMIT);

  if (scanned.ratings !== undefined) rich.ratings = scanned.ratings;

  if (checked !== undefined) rich.trailer = checked;

  if (scanned.recommendations !== undefined) {
    rich.recommendations = scanned.recommendations.slice(0, TITLE_LIST_LIMIT);
  }

  return rich;
};

const titleMetadata = (scanned: ScannedTitle) => {
  const sortName = scanned.sortName ?? scanned.name;

  return {
    ...richMetadata(scanned),
    kind: scanned.kind,
    name: scanned.name,
    sortName,
    sortKey: sortName.toLowerCase(),
    year: scanned.year,
    overview: scanned.overview,
    tagline: scanned.tagline,
    genres: keptGenres(scanned.genres),
    certification: scanned.certification,
    ageRating: scanned.ageRating,
    runtimeMs: scanned.runtimeMs,
    artwork: scanned.artwork,
    externalIds: scanned.externalIds,
  };
};

const keepKnown = (scanned: ScannedTitle, existing: Doc<"titles">): ScannedTitle => {
  const externalIds = {
    tmdb: scanned.externalIds.tmdb ?? existing.externalIds.tmdb,
    imdb: scanned.externalIds.imdb ?? existing.externalIds.imdb,
    tvdb: scanned.externalIds.tvdb ?? existing.externalIds.tvdb,
  };

  const identified = Object.values(externalIds).some((id) => id !== null);
  const stored = existing.ratings;

  const ratings =
    scanned.ratings === undefined || stored === undefined
      ? scanned.ratings
      : {
          tmdb: scanned.ratings.tmdb ?? stored.tmdb,
          imdb: scanned.ratings.imdb ?? stored.imdb,
          rottenTomatoes: scanned.ratings.rottenTomatoes ?? stored.rottenTomatoes,
          metacritic: scanned.ratings.metacritic ?? stored.metacritic,
        };

  const kept: ScannedTitle = {
    ...scanned,
    externalIds,
    matchStatus:
      identified && existing.matchStatus !== "unmatched" ? "matched" : scanned.matchStatus,
  };

  if (ratings !== undefined) kept.ratings = ratings;

  return kept;
};

/**
 * What a scan or metadata job writes onto a stored title: the scanned fields with the ids and
 * scores it keeps, sorted and searched under the overrides an admin made.
 */
export const rescannedTitle = (scanned: ScannedTitle, existing: Doc<"titles">) => {
  const merged = keepKnown(scanned, existing);
  const metadata = titleMetadata(merged);
  const named = { ...metadata, overrides: existing.overrides };

  return {
    ...metadata,
    matchStatus: merged.matchStatus,
    sortKey: sortKeyOf(named),
    searchText: searchTextOf(named),
  };
};

/** Writes `fields` onto a stored title when they change it, and keeps its genre rows in step. */
export const rewriteTitle = async (
  db: Db,
  existing: Doc<"titles">,
  fields: Partial<Doc<"titles">>,
): Promise<Doc<"titles">> => {
  if (!changesAny(existing, fields)) return existing;

  const updated = { ...existing, ...fields, updatedAt: Date.now() };

  await db.patch(existing._id, { ...fields, updatedAt: updated.updatedAt });
  await syncTitleGenres(db, updated);

  return updated;
};

type Overrides = NonNullable<Doc<"titles">["overrides"]>;

/**
 * Stores an admin's edits on a title and sorts, searches, and lists its genre rows under them.
 * Edits that change nothing write nothing. A title has at most 256 genre rows, so this stays a
 * small, bounded write.
 */
export const writeOverrides = async (
  db: Db,
  title: Doc<"titles">,
  overrides: Overrides,
): Promise<Doc<"titles">> => {
  const named = { ...title, overrides };

  return rewriteTitle(db, title, {
    overrides,
    sortKey: sortKeyOf(named),
    searchText: searchTextOf(named),
  });
};

interface Landed<Row> {
  readonly row: Row;
  readonly moved: Moved;
}

const upsertTitle = async (
  db: Db,
  libraryId: Id<"libraries">,
  scanned: ScannedTitle,
  previous: Doc<"titles"> | null,
): Promise<Landed<Doc<"titles">>> => {
  const unchanged = { moved: nothingMoved };
  const kept = previous?.purging === true ? null : previous;

  if (kept?.matchStatus === "manual") return { row: kept, ...unchanged };

  const existing =
    kept?.libraryId === libraryId && kept.matchKey === scanned.matchKey
      ? kept
      : await db
          .query("titles")
          .withIndex("by_library_match", (q) =>
            q.eq("libraryId", libraryId).eq("matchKey", scanned.matchKey),
          )
          .unique();

  if (existing !== null) {
    if (existing.matchStatus === "manual") return { row: existing, ...unchanged };

    return {
      row: await rewriteTitle(db, existing, rescannedTitle(scanned, existing)),
      ...unchanged,
    };
  }

  const now = Date.now();
  const metadata = titleMetadata(scanned);

  const fields = {
    libraryId,
    matchKey: scanned.matchKey,
    ...metadata,
    matchStatus: scanned.matchStatus,
    presentFileCount: 0,
    episodeCount: 0,
    matchGeneration: 0,
    addedAt: now,
    updatedAt: now,
    searchText: searchTextOf(metadata),
  };

  const titleId = await db.insert("titles", fields);
  const created = { ...fields, _id: titleId, _creationTime: now };

  await syncTitleGenres(db, created);

  return { row: created, moved: { ...nothingMoved, titles: 1 } };
};

/** Finds or creates a show's season and episode, and updates their names and artwork. */
export const upsertEpisode = async (
  db: Db,
  titleId: Id<"titles">,
  scanned: Infer<typeof scannedEpisode>,
): Promise<Landed<Doc<"episodes">>> => {
  const season = await db
    .query("seasons")
    .withIndex("by_title_number", (q) =>
      q.eq("titleId", titleId).eq("seasonNumber", scanned.seasonNumber),
    )
    .unique();

  const seasonName =
    scanned.seasonName ??
    (scanned.seasonNumber === 0 ? "Specials" : `Season ${scanned.seasonNumber}`);

  const seasonId =
    season?._id ??
    (await db.insert("seasons", {
      titleId,
      seasonNumber: scanned.seasonNumber,
      name: seasonName,
      poster: scanned.seasonPoster,
      episodeCount: 0,
      externalIds: scanned.seasonExternalIds ?? NO_EXTERNAL_IDS,
    }));

  if (season !== null) {
    const seasonFields = {
      name: scanned.seasonName ?? season.name,
      poster: scanned.seasonPoster ?? season.poster,
      externalIds: scanned.seasonExternalIds ?? season.externalIds,
    };

    if (changesAny(season, seasonFields)) await db.patch(season._id, seasonFields);
  }

  const existing = await db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q
        .eq("titleId", titleId)
        .eq("seasonNumber", scanned.seasonNumber)
        .eq("episodeNumber", scanned.episodeNumber),
    )
    .unique();

  const fields = {
    name: scanned.name ?? existing?.name ?? `Episode ${scanned.episodeNumber}`,
    overview: scanned.overview ?? existing?.overview ?? null,
    airDate: scanned.airDate ?? existing?.airDate ?? null,
    runtimeMs: scanned.runtimeMs ?? existing?.runtimeMs ?? null,
    still: scanned.still ?? existing?.still ?? null,
    rating: scanned.rating ?? existing?.rating ?? null,
    externalIds: scanned.externalIds ?? existing?.externalIds ?? NO_EXTERNAL_IDS,
  };

  if (existing !== null) {
    if (changesAny(existing, fields)) await db.patch(existing._id, fields);

    return { row: { ...existing, ...fields }, moved: nothingMoved };
  }

  const row = {
    titleId,
    seasonId,
    seasonNumber: scanned.seasonNumber,
    episodeNumber: scanned.episodeNumber,
    ...fields,
    presentFileCount: 0,
  };

  const episodeId = await db.insert("episodes", row);
  const seasonDoc = season ?? (await db.get(seasonId));
  const title = await db.get(titleId);

  if (seasonDoc !== null) {
    await db.patch(seasonId, { episodeCount: seasonDoc.episodeCount + 1 });
  }

  if (title !== null) await db.patch(titleId, { episodeCount: title.episodeCount + 1 });

  return {
    row: { ...row, _id: episodeId, _creationTime: Date.now() },
    moved: { ...nothingMoved, episodes: 1 },
  };
};

/** Moves the present-file count of a title, and of its episode when it has one, by `delta`. */
export const adjustPresent = async (
  db: Db,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
  delta: number,
): Promise<void> => {
  const title = await db.get(titleId);

  if (title !== null) {
    await db.patch(titleId, { presentFileCount: Math.max(0, title.presentFileCount + delta) });
  }

  if (episodeId === null) return;

  const episode = await db.get(episodeId);

  if (episode !== null) {
    await db.patch(episodeId, { presentFileCount: Math.max(0, episode.presentFileCount + delta) });
  }
};

/** A file of a library by path. */
export const fileAt = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  path: string,
): Promise<Doc<"mediaFiles"> | null> =>
  db
    .query("mediaFiles")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
    .unique();

/**
 * Every database operation, a `get`, query, insert, patch, or delete, is charged one index range
 * and every insert, patch, or delete one write: an upper bound, since Convex counts at most that.
 * Besides the genre rows, a file costs at most 42 operations and 21 writes: the file, the title it
 * plays now, and the title its key names, read to price it (3); the same read again to write it
 * (3); the title written (1); a season and an episode looked up, written, and the season's and
 * the title's episode counts moved (8); the file written (1); the present-file counts of an old and a new title and episode
 * (8); and its thumbnail job read, canceled, queued again, and recorded (16, with 2 to spare).
 * Each genre row the title has is deleted or patched, and each it gains inserted: one operation
 * and one write each, plus the one query that lists them.
 */
const UPSERT_COST = work(42, 21);

/** The worst case of `upsertScannedItem` for `item`, after reading what prices it (counted). */
export const upsertCost = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  item: Infer<typeof scannedItem>,
): Promise<Work> => {
  const existingFile = await fileAt(db, libraryId, item.file.path);
  const previous = existingFile === null ? null : await db.get(existingFile.titleId);

  const named = await db
    .query("titles")
    .withIndex("by_library_match", (q) =>
      q.eq("libraryId", libraryId).eq("matchKey", item.title.matchKey),
    )
    .first();

  const stored = Math.max(genreRows(previous?.genres ?? []), genreRows(named?.genres ?? []));
  const rows = 1 + stored + genreRows(item.title.genres);

  return addWork(UPSERT_COST, work(rows, rows));
};

/**
 * The worst case of `markFileMissing`: the file looked up, its thumbnail job read and canceled,
 * its state cleared, the file marked, and its title's and episode's present counts moved.
 */
export const MISSING_COST = work(16, 8);

/** The worst case of rewriting `current` from `scanned`: its row, and each genre row. */
export const rewriteCost = (current: Doc<"titles">, scanned: ScannedTitle): Work => {
  const rows = 2 + genreRows(current.genres) + genreRows(scanned.genres);

  return work(rows, rows);
};

/**
 * The worst case of `upsertEpisode`: a season and an episode looked up and written, the season
 * read again and its count moved, and the title read and its episode count moved.
 */
export const EPISODE_COST = work(10, 5);

/**
 * Inserts or updates one scanned file with its title and episode, and queues scrub thumbnails
 * when the file is new or changed. A title an admin matched by hand keeps its metadata.
 */
export const upsertScannedItem = async (
  ctx: JobCtx,
  libraryId: Id<"libraries">,
  item: Infer<typeof scannedItem>,
): Promise<Landed<Infer<typeof upsertedFile>>> => {
  const { db } = ctx;
  const existingFile = await fileAt(db, libraryId, item.file.path);
  const previousTitle = existingFile === null ? null : await db.get(existingFile.titleId);
  const title = await upsertTitle(db, libraryId, item.title, previousTitle);

  const episode =
    title.row.kind === "show" && item.episode !== null
      ? await upsertEpisode(db, title.row._id, item.episode)
      : null;

  const episodeId = episode?.row._id ?? null;

  const landed = {
    path: item.file.path,
    titleId: title.row._id,
    episodeId,
    titleCreditsHash: title.row.creditsHash ?? null,
    episodeCreditsHash: episode?.row.creditsHash ?? null,
    collectionHash: title.row.collectionHash ?? null,
  };

  const fields = {
    titleId: title.row._id,
    episodeId,
    sizeBytes: item.file.sizeBytes,
    mtimeMs: item.file.mtimeMs,
    probe: item.file.probe,
    externalSubtitles: item.file.externalSubtitles,
    versionName: item.file.versionName,
    sidecarDigest: item.file.sidecarDigest ?? null,
    hdr: (item.file.probe.video[0]?.hdr ?? "none") !== "none",
    missing: false,
  };

  const found = {
    titles: title.moved.titles,
    episodes: episode?.moved.episodes ?? 0,
  };

  if (existingFile === null) {
    const now = Date.now();
    const row = { libraryId, path: item.file.path, ...fields, addedAt: now };
    const fileId = await db.insert("mediaFiles", row);

    await adjustPresent(db, title.row._id, episodeId, 1);
    await queueTrickplay(ctx, { ...row, _id: fileId, _creationTime: now }, false);

    return { row: { ...landed, fileId }, moved: { ...found, files: 1 } };
  }

  const { missingSince: _wasMissingSince, ...present } = existingFile;
  const stillThere = { ...present, ...fields };

  if (changesAny(existingFile, { ...fields, missingSince: undefined })) {
    await db.patch(existingFile._id, { ...fields, missingSince: undefined });
  }

  await queueTrickplay(ctx, stillThere, false);

  const moved = existingFile.titleId !== title.row._id || existingFile.episodeId !== episodeId;

  if (!existingFile.missing && moved) {
    await adjustPresent(db, existingFile.titleId, existingFile.episodeId, -1);
  }

  if (existingFile.missing || moved) await adjustPresent(db, title.row._id, episodeId, 1);

  return { row: { ...landed, fileId: existingFile._id }, moved: { ...found, files: 0 } };
};

/**
 * Marks a file missing. Its title and episode stay, with any history pointing at them; its scrub
 * thumbnails are forgotten, so a file that returns gets new ones. Answers whether it changed.
 */
export const markFileMissing = async (
  ctx: JobCtx,
  libraryId: Id<"libraries">,
  path: string,
): Promise<boolean> => {
  const file = await fileAt(ctx.db, libraryId, path);

  if (file === null || file.missing) return false;

  await forgetTrickplay(ctx, file);
  await ctx.db.patch(file._id, { missing: true, missingSince: Date.now() });
  await adjustPresent(ctx.db, file.titleId, file.episodeId, -1);

  return true;
};
