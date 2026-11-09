import type { PaginationOptions, PaginationResult } from "convex/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginate } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import type { ItemGate } from "../core/permissions/grants";
import type { Principal } from "../core/permissions/policy";
import { libraryGate, nextBrowsableLibrary } from "./access";
import type { NextLibrary } from "./access";
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

/** Where a cursor sits: inside a library's index, or past the end of a library. */
type Position = "paging" | "done";

const FLAGS = { paging: "p", done: "d" } as const satisfies Readonly<Record<Position, string>>;

interface Spot {
  readonly libraryId: Id<"libraries">;
  readonly position: Position;
  readonly inner: string | null;
}

const badCursor = (): never => fail("invalid_args", "This page cursor did not come from this list");

const spotOf = (db: DatabaseReader, cursor: string | null | undefined): Spot | null => {
  if (cursor === undefined || cursor === null || cursor === "") return null;

  const [id = "", flag = "", ...rest] = cursor.split(SEPARATOR);
  const libraryId = db.normalizeId("libraries", id);
  const inner = rest.join(SEPARATOR);

  if (libraryId === null || (flag !== FLAGS.paging && flag !== FLAGS.done)) return badCursor();

  return {
    libraryId,
    position: flag === FLAGS.done ? "done" : "paging",
    inner: inner === "" ? null : inner,
  };
};

const cursorAt = (libraryId: Id<"libraries">, position: Position, inner: string): string =>
  [libraryId, FLAGS[position], inner].join(SEPARATOR);

type Start =
  | { readonly kind: "page"; readonly gate: ItemGate; readonly inner: string | null }
  | NextLibrary;

/** The library a page reads and where in it, or where the walk resumes, or its end. */
const startOf = async (
  db: DatabaseReader,
  caller: Principal,
  from: Spot | null,
): Promise<Start> => {
  if (from === null) return nextBrowsableLibrary(db, caller, null);

  if (from.position === "paging") {
    const gate = await libraryGate(db, caller, await reachOf(db, caller), from.libraryId);

    if (gate !== null) return { kind: "page", gate, inner: from.inner };
  }

  return nextBrowsableLibrary(db, caller, from.libraryId);
};

/**
 * One page of the titles in every movies library shared with `caller`, a library at a time in
 * id order. Each call pages one library's index once, since Convex runs one paginated query per
 * call. The cursor names the library and either Convex's cursor inside it or that the library is
 * done; the next call after a done library finds the next one through the caller's grants. A
 * library the caller lost meanwhile counts as done. A page reloaded to its end cursor reads the
 * same range of the same library again.
 */
export const libraryByLibrary = async (
  db: DatabaseReader,
  caller: Principal,
  sort: TitleSort,
  filter: TitleFilter,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<"titles">>> => {
  const through = spotOf(db, options.endCursor);
  const start = await startOf(db, caller, spotOf(db, options.cursor));
  const reloaded = through === null ? null : (options.endCursor ?? null);

  if (start.kind === "end") {
    return {
      page: [],
      isDone: reloaded === null,
      continueCursor: reloaded ?? options.cursor ?? "",
    };
  }

  if (start.kind === "resume") {
    return {
      page: [],
      isDone: false,
      continueCursor: reloaded ?? cursorAt(start.after, "done", ""),
    };
  }

  const { gate } = start;
  const libraryId = gate.library._id;

  const page = await libraryPage(db, gate, sort, filter, {
    ...options,
    cursor: start.kind === "page" ? start.inner : null,
    endCursor: through?.libraryId === libraryId ? through.inner : null,
  });

  const last =
    reloaded === null &&
    page.isDone &&
    (await nextBrowsableLibrary(db, caller, libraryId)).kind === "end";

  const answer = {
    ...page,
    isDone: last,
    continueCursor:
      reloaded ?? cursorAt(libraryId, page.isDone ? "done" : "paging", page.continueCursor),
  };

  const split = page.splitCursor;

  return split === undefined || split === null
    ? answer
    : { ...answer, splitCursor: cursorAt(libraryId, "paging", split) };
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
