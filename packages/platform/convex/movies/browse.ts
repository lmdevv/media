import type { PaginationOptions, PaginationResult } from "convex/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginate } from "../core/lib/paginate";
import type { ItemGate } from "../core/permissions/grants";
import { titleFacts } from "./items";

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

type Paged = PaginationResult<Doc<"titles"> | null>;

const byTitle = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  sort: TitleSort,
  options: PaginationOptions,
): Promise<Paged> => {
  if (sort === "name") {
    return paginate(
      db,
      { table: "titles", index: "by_library_sort", range: (q) => q.eq("libraryId", libraryId) },
      options,
    );
  }

  return sort === "added"
    ? paginate(
        db,
        {
          table: "titles",
          index: "by_library_added",
          range: (q) => q.eq("libraryId", libraryId),
          order: "desc",
        },
        options,
      )
    : paginate(
        db,
        {
          table: "titles",
          index: "by_library_year",
          range: (q) => q.eq("libraryId", libraryId),
          order: "desc",
        },
        options,
      );
};

const genreRows = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  genre: string,
  sort: TitleSort,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<"titleGenres">>> => {
  if (sort === "name") {
    return paginate(
      db,
      {
        table: "titleGenres",
        index: "by_library_genre_sort",
        range: (q) => q.eq("libraryId", libraryId).eq("genre", genre),
      },
      options,
    );
  }

  return sort === "added"
    ? paginate(
        db,
        {
          table: "titleGenres",
          index: "by_library_genre_added",
          range: (q) => q.eq("libraryId", libraryId).eq("genre", genre),
          order: "desc",
        },
        options,
      )
    : paginate(
        db,
        {
          table: "titleGenres",
          index: "by_library_genre_year",
          range: (q) => q.eq("libraryId", libraryId).eq("genre", genre),
          order: "desc",
        },
        options,
      );
};

const byGenre = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  genre: string,
  sort: TitleSort,
  options: PaginationOptions,
): Promise<Paged> => {
  const rows = await genreRows(db, libraryId, folded(genre), sort, options);

  return { ...rows, page: await Promise.all(rows.page.map(async (row) => db.get(row.titleId))) };
};

/**
 * One page of one library's titles by index, in `sort` order, keeping the ones `gate` admits and
 * `filter` passes. A genre pages its own `titleGenres` rows, which carry the title's sort fields,
 * so a rare genre reads only its titles. Restrictions and filters can make a page short, and its
 * cursor still continues after the last row read.
 */
export const libraryPage = async (
  db: DatabaseReader,
  gate: ItemGate,
  sort: TitleSort,
  filter: TitleFilter,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<"titles">>> => {
  const bounded = { ...options, numItems: Math.min(options.numItems, TITLE_PAGE_MAX) };
  const libraryId = gate.library._id;

  const found =
    filter.genre === undefined
      ? await byTitle(db, libraryId, sort, bounded)
      : await byGenre(db, libraryId, filter.genre, sort, bounded);

  return {
    ...found,
    page: found.page.flatMap((title) =>
      title === null ||
      title.purging === true ||
      !gate.admits(titleFacts(title)) ||
      !matchesFilter(filter, title)
        ? []
        : [title],
    ),
  };
};

const SEPARATOR = "|";

interface Spot {
  readonly libraryId: Id<"libraries">;
  readonly inner: string | null;
}

const spotOf = (db: DatabaseReader, cursor: string | null | undefined): Spot | null => {
  if (cursor === undefined || cursor === null || cursor === "") return null;

  const at = cursor.indexOf(SEPARATOR);
  const libraryId = at < 0 ? null : db.normalizeId("libraries", cursor.slice(0, at));

  if (libraryId === null)
    return fail("invalid_args", "This page cursor did not come from this list");

  const inner = cursor.slice(at + 1);

  return { libraryId, inner: inner === "" ? null : inner };
};

const cursorAt = (libraryId: Id<"libraries">, inner: string): string =>
  `${libraryId}${SEPARATOR}${inner}`;

/**
 * One page of the titles in every library of `gates`, a library at a time in their order. Each
 * call pages one library's index once, since Convex runs one paginated query per call. The cursor
 * names the library and Convex's cursor inside it; when a library ends, the cursor names the next
 * library's start, so the next page begins there. A page reloaded to its end cursor reads the same
 * range of the same library again.
 */
export const libraryByLibrary = async (
  db: DatabaseReader,
  gates: ReadonlyArray<ItemGate>,
  sort: TitleSort,
  filter: TitleFilter,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<"titles">>> => {
  const from = spotOf(db, options.cursor);
  const through = spotOf(db, options.endCursor);
  const index = from === null ? 0 : gates.findIndex((gate) => gate.library._id === from.libraryId);
  const gate = gates[index];

  if (gate === undefined) return { page: [], isDone: true, continueCursor: options.cursor ?? "" };

  const libraryId = gate.library._id;
  const ending = through?.libraryId === libraryId ? through.inner : null;

  const page = await libraryPage(db, gate, sort, filter, {
    ...options,
    cursor: from?.inner ?? null,
    endCursor: ending,
  });

  const next = gates[index + 1];
  const split = page.splitCursor;

  const continueCursor =
    options.endCursor !== undefined && options.endCursor !== null && options.endCursor !== ""
      ? options.endCursor
      : page.isDone && next !== undefined
        ? cursorAt(next.library._id, "")
        : cursorAt(libraryId, page.continueCursor);

  const answer = { ...page, isDone: page.isDone && next === undefined, continueCursor };

  return split === undefined || split === null
    ? answer
    : { ...answer, splitCursor: cursorAt(libraryId, split) };
};

/**
 * Up to `count` of the most recently added titles across `gates` that each library's gate admits,
 * reading each library's newest titles, about the same share from each. Genres and "more like
 * this" count among these, so a vast library counts its newer part.
 */
export const recentTitles = async (
  db: DatabaseReader,
  gates: ReadonlyArray<ItemGate>,
  kind: Doc<"titles">["kind"] | undefined,
  count: number,
): Promise<ReadonlyArray<Doc<"titles">>> => {
  const share = Math.max(10, Math.ceil(count / Math.max(1, gates.length)));

  const read = await Promise.all(
    gates.map(async (gate) => {
      const titles = await db
        .query("titles")
        .withIndex("by_library_added", (q) => q.eq("libraryId", gate.library._id))
        .order("desc")
        .take(share);

      return titles.filter(
        (title) =>
          title.purging !== true &&
          (kind === undefined || title.kind === kind) &&
          gate.admits(titleFacts(title)),
      );
    }),
  );

  return read.flat();
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
