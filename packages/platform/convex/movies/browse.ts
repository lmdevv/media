import type { PaginationOptions, PaginationResult } from "convex/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { paginateAtMost } from "../core/lib/paginate";
import type { TitleViewer } from "./access";

/** The orders a title list offers: by name, newest added, or newest year. */
export type TitleSort = "name" | "added" | "year";

/** What a title list may narrow by besides its library. */
export interface TitleFilter {
  readonly kind?: Doc<"titles">["kind"] | undefined;
  readonly genre?: string | undefined;
  readonly yearFrom?: number | undefined;
  readonly yearTo?: number | undefined;
  readonly studio?: string | undefined;
  readonly minRating?: number | undefined;
}

/** Most titles one list page holds, as old movies' title list allowed. */
export const TITLE_PAGE_MAX = 100;

const folded = (text: string): string => text.trim().toLowerCase();

const communityScore = (title: Doc<"titles">): number | null =>
  title.ratings?.imdb?.value ?? title.ratings?.tmdb?.value ?? null;

const yearOf = (title: Doc<"titles">): number | null => title.overrides?.year ?? title.year;

/** Whether a title passes every filter that is set. */
export const matchesFilter = (filter: TitleFilter, title: Doc<"titles">): boolean => {
  const { genre, studio, kind } = filter;
  const year = yearOf(title);
  const score = communityScore(title);

  return (
    (kind === undefined || title.kind === kind) &&
    (genre === undefined || title.genres.some((name) => folded(name) === folded(genre))) &&
    (studio === undefined ||
      (title.studios ?? []).some((name) => folded(name) === folded(studio))) &&
    (filter.yearFrom === undefined || (year !== null && year >= filter.yearFrom)) &&
    (filter.yearTo === undefined || (year !== null && year <= filter.yearTo)) &&
    (filter.minRating === undefined || (score !== null && score >= filter.minRating))
  );
};

type Kind = Doc<"titles">["kind"];

/** Where a title list reads: one library, one kind, or every title on the server. */
interface Scope {
  readonly libraryId?: Id<"libraries"> | undefined;
  readonly kind?: Kind | undefined;
}

type Page<Row> = Promise<PaginationResult<Row>>;

const ofLibrary = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titles">> => {
  if (sort === "name") {
    return paginateAtMost(
      db,
      { table: "titles", index: "by_library_sort", range: (q) => q.eq("libraryId", libraryId) },
      options,
      rows,
    );
  }

  return sort === "added"
    ? paginateAtMost(
        db,
        {
          table: "titles",
          index: "by_library_added",
          range: (q) => q.eq("libraryId", libraryId),
          order: "desc",
        },
        options,
        rows,
      )
    : paginateAtMost(
        db,
        {
          table: "titles",
          index: "by_library_year",
          range: (q) => q.eq("libraryId", libraryId),
          order: "desc",
        },
        options,
        rows,
      );
};

const ofKind = (
  db: DatabaseReader,
  kind: Kind,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titles">> => {
  if (sort === "name") {
    return paginateAtMost(
      db,
      { table: "titles", index: "by_kind_sort", range: (q) => q.eq("kind", kind) },
      options,
      rows,
    );
  }

  return sort === "added"
    ? paginateAtMost(
        db,
        {
          table: "titles",
          index: "by_kind_added",
          range: (q) => q.eq("kind", kind),
          order: "desc",
        },
        options,
        rows,
      )
    : paginateAtMost(
        db,
        { table: "titles", index: "by_kind_year", range: (q) => q.eq("kind", kind), order: "desc" },
        options,
        rows,
      );
};

const ofEvery = (
  db: DatabaseReader,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titles">> => {
  if (sort === "name") {
    return paginateAtMost(db, { table: "titles", index: "by_sort" }, options, rows);
  }

  return sort === "added"
    ? paginateAtMost(db, { table: "titles", index: "by_added", order: "desc" }, options, rows)
    : paginateAtMost(db, { table: "titles", index: "by_year", order: "desc" }, options, rows);
};

const genreOfLibrary = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  genre: string,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titleGenres">> => {
  if (sort === "name") {
    return paginateAtMost(
      db,
      {
        table: "titleGenres",
        index: "by_library_genre_sort",
        range: (q) => q.eq("libraryId", libraryId).eq("genre", genre),
      },
      options,
      rows,
    );
  }

  return sort === "added"
    ? paginateAtMost(
        db,
        {
          table: "titleGenres",
          index: "by_library_genre_added",
          range: (q) => q.eq("libraryId", libraryId).eq("genre", genre),
          order: "desc",
        },
        options,
        rows,
      )
    : paginateAtMost(
        db,
        {
          table: "titleGenres",
          index: "by_library_genre_year",
          range: (q) => q.eq("libraryId", libraryId).eq("genre", genre),
          order: "desc",
        },
        options,
        rows,
      );
};

const genreOfKind = (
  db: DatabaseReader,
  kind: Kind,
  genre: string,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titleGenres">> => {
  if (sort === "name") {
    return paginateAtMost(
      db,
      {
        table: "titleGenres",
        index: "by_kind_genre_sort",
        range: (q) => q.eq("kind", kind).eq("genre", genre),
      },
      options,
      rows,
    );
  }

  return sort === "added"
    ? paginateAtMost(
        db,
        {
          table: "titleGenres",
          index: "by_kind_genre_added",
          range: (q) => q.eq("kind", kind).eq("genre", genre),
          order: "desc",
        },
        options,
        rows,
      )
    : paginateAtMost(
        db,
        {
          table: "titleGenres",
          index: "by_kind_genre_year",
          range: (q) => q.eq("kind", kind).eq("genre", genre),
          order: "desc",
        },
        options,
        rows,
      );
};

const genreOfEvery = (
  db: DatabaseReader,
  genre: string,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titleGenres">> => {
  if (sort === "name") {
    return paginateAtMost(
      db,
      { table: "titleGenres", index: "by_genre_sort", range: (q) => q.eq("genre", genre) },
      options,
      rows,
    );
  }

  return sort === "added"
    ? paginateAtMost(
        db,
        {
          table: "titleGenres",
          index: "by_genre_added",
          range: (q) => q.eq("genre", genre),
          order: "desc",
        },
        options,
        rows,
      )
    : paginateAtMost(
        db,
        {
          table: "titleGenres",
          index: "by_genre_year",
          range: (q) => q.eq("genre", genre),
          order: "desc",
        },
        options,
        rows,
      );
};

const titleRows = async (
  db: DatabaseReader,
  scope: Scope,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titles">> => {
  const { libraryId, kind } = scope;

  if (libraryId !== undefined) return ofLibrary(db, libraryId, sort, options, rows);

  return kind === undefined
    ? ofEvery(db, sort, options, rows)
    : ofKind(db, kind, sort, options, rows);
};

const genreRows = async (
  db: DatabaseReader,
  scope: Scope,
  genre: string,
  sort: TitleSort,
  options: PaginationOptions,
  rows: number,
): Page<Doc<"titles"> | null> => {
  const { libraryId, kind } = scope;
  const key = folded(genre);

  const found =
    libraryId !== undefined
      ? await genreOfLibrary(db, libraryId, key, sort, options, rows)
      : kind === undefined
        ? await genreOfEvery(db, key, sort, options, rows)
        : await genreOfKind(db, kind, key, sort, options, rows);

  return { ...found, page: await Promise.all(found.page.map(async (row) => db.get(row.titleId))) };
};

/**
 * One page of titles in `sort` order across every library, or within one library, through the
 * index that matches the library, kind, and genre asked for. It reads at most `rows` rows, so a
 * caller's page stays within the reads `decidableRows` allows, and keeps the titles `sees`
 * allows through `can()` and `filter` passes. Titles the caller may not see, restrictions, and
 * filters can make a page short or empty while its cursor goes on.
 */
export const titlePage = async (
  db: DatabaseReader,
  scope: Scope,
  sort: TitleSort,
  filter: TitleFilter,
  sees: TitleViewer,
  options: PaginationOptions,
  rows: number,
): Promise<PaginationResult<Doc<"titles">>> => {
  const bounded = Math.min(rows, TITLE_PAGE_MAX);
  const scoped = { libraryId: scope.libraryId, kind: scope.kind ?? filter.kind };

  const found =
    filter.genre === undefined
      ? await titleRows(db, scoped, sort, options, bounded)
      : await genreRows(db, scoped, filter.genre, sort, options, bounded);

  const kept = await Promise.all(
    found.page.map(async (title) =>
      title !== null && matchesFilter(filter, title) && (await sees(title)) ? title : null,
    ),
  );

  return { ...found, page: kept.flatMap((title) => (title === null ? [] : [title])) };
};

/** Genres across `titles` with their counts, most common first, then by name. */
export const countGenres = (
  titles: ReadonlyArray<Doc<"titles">>,
): ReadonlyArray<{ readonly name: string; readonly count: number }> => {
  const counts = new Map<string, { readonly name: string; readonly count: number }>();

  for (const name of titles.flatMap((title) => title.genres)) {
    const key = folded(name);
    const entry = counts.get(key);

    counts.set(key, { name: entry?.name ?? name, count: (entry?.count ?? 0) + 1 });
  }

  return [...counts.values()].toSorted(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );
};

const overlap = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  const wanted = new Set(left.map(folded));

  return right.filter((value) => wanted.has(folded(value))).length;
};

const similarity = (title: Doc<"titles">, candidate: Doc<"titles">): number =>
  2 * overlap(title.genres, candidate.genres) +
  overlap(title.tags ?? [], candidate.tags ?? []) +
  overlap(title.studios ?? [], candidate.studios ?? []);

/**
 * Candidates ranked by how alike they are to `title` by metadata alone, best first: shared genres
 * count twice, shared keywords and studios once. Ties go to the closer year, then the better
 * score; titles with nothing in common are left out.
 */
export const rankBySimilarity = (
  title: Doc<"titles">,
  candidates: ReadonlyArray<Doc<"titles">>,
): ReadonlyArray<Doc<"titles">> => {
  const year = yearOf(title);

  const distance = (candidate: Doc<"titles">): number => {
    const candidateYear = yearOf(candidate);

    return year === null || candidateYear === null
      ? Number.MAX_SAFE_INTEGER
      : Math.abs(candidateYear - year);
  };

  return candidates
    .flatMap((candidate) => {
      const score = similarity(title, candidate);

      return score > 0 && candidate._id !== title._id ? [{ candidate, score }] : [];
    })
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        distance(left.candidate) - distance(right.candidate) ||
        (communityScore(right.candidate) ?? 0) - (communityScore(left.candidate) ?? 0),
    )
    .map((entry) => entry.candidate);
};
