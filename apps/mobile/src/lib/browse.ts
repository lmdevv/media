import type { CommandArgs } from "@movies/contracts/commands";
import type { LibraryId, ProfileId, TitleId } from "@movies/contracts/ids";
import type {
  HistoryEntry,
  Home,
  Library,
  TitleCard,
  TitleDetail,
  TitleKind,
  TitleSort,
} from "@movies/contracts/models/catalog";

import { episodeCode, facts, formatRuntime, progressFraction } from "./format";
import type { WidthClass } from "./layout";
import { watchHref } from "./routes";

/** `1 movie`, `8 movies`. */
export const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const HERO_PAGES = 5;

/**
 * The titles the hero pages through: the server's featured title first, then the newest arrivals
 * that have wide artwork to fill the hero, without repeats.
 */
export const heroTitles = (
  featured: TitleCard | null,
  candidates: ReadonlyArray<TitleCard>,
): ReadonlyArray<TitleCard> => {
  const pages = featured === null ? [] : [featured];

  for (const title of candidates) {
    if (pages.length >= HERO_PAGES) break;

    if (title.artwork.backdrop !== null && pages.every((page) => page.id !== title.id)) {
      pages.push(title);
    }
  }

  return pages;
};

/**
 * Home's arrivals across both kinds, newest first: merges the movie and show rows, which each
 * arrive newest first. (Hermes has no `toSorted`, and merging keeps the server's order.)
 */
export const newestFirst = (
  movies: ReadonlyArray<TitleCard>,
  shows: ReadonlyArray<TitleCard>,
): ReadonlyArray<TitleCard> => {
  const merged: Array<TitleCard> = [];
  let movie = 0;
  let show = 0;

  while (movie < movies.length || show < shows.length) {
    const nextMovie = movies[movie];
    const nextShow = shows[show];

    if (
      nextShow === undefined ||
      (nextMovie !== undefined && nextMovie.addedAt >= nextShow.addedAt)
    ) {
      if (nextMovie !== undefined) merged.push(nextMovie);

      movie += 1;
    } else {
      merged.push(nextShow);
      show += 1;
    }
  }

  return merged;
};

/**
 * What Search offers before typing (E01, "Popular in Your Library"): the titles the profile is
 * watching, then its list, then the newest arrivals, each once. The server keeps no play counts,
 * so this is what Home already knows to be in play rather than a household ranking.
 */
export const popularTitles = (home: Home, limit: number): ReadonlyArray<TitleCard> => {
  const candidates = [
    ...home.continueWatching.map((item) => item.title),
    ...home.myList,
    ...newestFirst(home.recentlyAddedMovies, home.recentlyAddedShows),
  ];

  const seen = new Set<TitleId>();
  const picked: Array<TitleCard> = [];

  for (const title of candidates) {
    if (picked.length >= limit) break;

    if (!seen.has(title.id)) {
      seen.add(title.id);
      picked.push(title);
    }
  }

  return picked;
};

/**
 * The hero's line under the title, as C01 writes it: `Thriller · 2 seasons · TV-MA`, or the
 * running time for movies. A show's season count arrives with its details.
 */
export const heroFacts = (title: TitleCard, seasonCount: number | null): string =>
  facts(
    title.genres[0],
    title.kind === "show"
      ? seasonCount === null || seasonCount === 0
        ? title.year
        : plural(seasonCount, "season", "seasons")
      : title.runtimeMs === null
        ? title.year
        : formatRuntime(title.runtimeMs),
    title.certification,
  );

/** What a title's Play button says and where it goes. */
export interface PlayTarget {
  /** `Play`, `Resume`, `Play S1:E1`, or `Resume S2:E3`. */
  readonly label: string;
  readonly href: string;
}

/**
 * The play action for a title once its details load: resume a started movie, or resume or start
 * the show's next episode. Before the details arrive it plays the title from where the player
 * decides.
 */
export const playTarget = (
  titleId: TitleId,
  detail: Pick<TitleDetail, "kind" | "progress" | "nextEpisode"> | null,
): PlayTarget => {
  if (detail === null) return { label: "Play", href: watchHref({ titleId }) };

  if (detail.kind === "movie") {
    const started =
      detail.progress !== null &&
      !detail.progress.watched &&
      progressFraction(detail.progress) !== null;

    return { label: started ? "Resume" : "Play", href: watchHref({ titleId }) };
  }

  const next = detail.nextEpisode;

  if (next === null) return { label: "Play", href: watchHref({ titleId }) };

  const started = next.progress !== null && !next.progress.watched && next.progress.positionMs > 0;

  return {
    label: `${started ? "Resume" : "Play"} ${episodeCode(next)}`,
    href: watchHref({ titleId, episodeId: next.id }),
  };
};

const SCANNING_UNTIL = 8;

/** Which Home the profile sees. */
export type HomeLayout =
  /** No library at all yet (C12). */
  | "empty"
  /** A library scans and few titles have arrived (C13). */
  | "scanning"
  /** Libraries exist but nothing in them is visible to this profile. */
  | "nothing"
  /** The hero and rows (C01). */
  | "rows";

/** Home's layout for these rows and libraries. */
export const homeLayout = (home: Home, libraries: ReadonlyArray<Library>): HomeLayout => {
  if (libraries.length === 0) return "empty";

  const arrived = home.recentlyAddedMovies.length + home.recentlyAddedShows.length;

  if (
    libraries.some((library) => library.scanning) &&
    (home.featured === null || arrived < SCANNING_UNTIL)
  ) {
    return "scanning";
  }

  if (home.featured === null && arrived === 0 && home.myList.length === 0) return "nothing";

  return "rows";
};

/** What Home draws for a profile: its layout, the arrivals, the hero's pages, and whether the hero fills the top. */
export interface HomeScreen {
  readonly layout: HomeLayout;
  readonly arrived: ReadonlyArray<TitleCard>;
  readonly pages: ReadonlyArray<TitleCard>;
  /** The full-bleed hero under the large title (C01), rather than the title on the page. */
  readonly fullBleed: boolean;
}

/** Home for these rows and libraries; Kids profiles get the inset billboard instead of the hero. */
export const homeScreen = (
  home: Home,
  libraries: ReadonlyArray<Library>,
  kids: boolean,
): HomeScreen => {
  const layout = homeLayout(home, libraries);
  const arrived = newestFirst(home.recentlyAddedMovies, home.recentlyAddedShows);
  const pages = heroTitles(home.featured, arrived);

  return { layout, arrived, pages, fullBleed: layout === "rows" && !kids && pages.length > 0 };
};

/** The libraries that hold titles of `kind`: their own kind, or mixed. */
export const librariesFor = (
  libraries: ReadonlyArray<Library>,
  kind: TitleKind,
): ReadonlyArray<Library> =>
  libraries.filter(
    (library) =>
      library.kind === "mixed" || library.kind === (kind === "movie" ? "movies" : "shows"),
  );

/** How the Movies and Shows grids are ordered and narrowed. */
export interface BrowseFilters {
  readonly sort: TitleSort;
  readonly genre: string | null;
  readonly libraryId: LibraryId | null;
}

/** Newest arrivals first, every genre, every library. */
export const DEFAULT_FILTERS: BrowseFilters = { sort: "added", genre: null, libraryId: null };

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/** The `titles.list` arguments for one page of a grid. */
export const listArgs = (
  profileId: ProfileId,
  kind: TitleKind | null,
  filters: BrowseFilters,
  cursor: string | null,
  limit: number,
): CommandArgs<"titles.list"> => {
  const args: Mutable<CommandArgs<"titles.list">> = {
    profileId,
    sort: filters.sort,
    cursor,
    limit,
  };

  if (kind !== null) args.kind = kind;

  if (filters.genre !== null) args.genre = filters.genre;

  if (filters.libraryId !== null) args.libraryId = filters.libraryId;

  return args;
};

/** `8 movies`, `12 shows`, or `5 titles` when a collection holds both kinds. */
export const titleCount = (titles: ReadonlyArray<Pick<TitleCard, "kind">>): string => {
  const kinds = new Set(titles.map((title) => title.kind));

  if (kinds.size === 1 && kinds.has("movie")) return plural(titles.length, "movie", "movies");

  if (kinds.size === 1 && kinds.has("show")) return plural(titles.length, "show", "shows");

  return plural(titles.length, "title", "titles");
};

/** `Movie · 2024` or `Show · 2019`: a title's kind and year in search rows. */
export const kindFacts = (title: Pick<TitleCard, "kind" | "year">): string =>
  facts(title.kind === "movie" ? "Movie" : "Show", title.year);

/** Where a profile stands on a title, as far as its history tells. */
export type WatchState = "watched" | "started";

/**
 * Each title's watch state from history. A movie is watched when its entry says so. A show is
 * watched when every episode in its history is (as after Mark as Watched, which marks them all),
 * and started otherwise; history cannot tell an episode never played, so a show whose played
 * episodes are all finished counts as watched. Titles without history are absent.
 */
export const watchStates = (
  entries: ReadonlyArray<Pick<HistoryEntry, "title" | "episode" | "progress">>,
): ReadonlyMap<TitleId, WatchState> => {
  const states = new Map<TitleId, WatchState>();

  for (const entry of entries) {
    const state = entry.progress.watched ? "watched" : "started";

    if (entry.episode === null || states.get(entry.title.id) !== "started") {
      states.set(entry.title.id, state);
    }
  }

  return states;
};

/** Which kinds a list shows: both, or one. */
export type KindFilter = "all" | TitleKind;

/** The All, Movies, and Shows chips of My List, Search, and genre pages. */
export const KIND_FILTERS: ReadonlyArray<{ readonly kind: KindFilter; readonly label: string }> = [
  { kind: "all", label: "All" },
  { kind: "movie", label: "Movies" },
  { kind: "show", label: "Shows" },
];

/** The titles of `kind`, or all of them. */
export const ofKind = (
  titles: ReadonlyArray<TitleCard>,
  kind: KindFilter,
): ReadonlyArray<TitleCard> =>
  kind === "all" ? titles : titles.filter((title) => title.kind === kind);

/** The space around a grid's posters, in points: the page's side gutter and the gap between them. */
export interface GridSpacing {
  readonly gutter: number;
  readonly gap: number;
}

/** Paper's grid spacing for each width class, the same as `px-5 gap-2`, `px-8 gap-3`, `px-12 gap-3`. */
export const GRID_SPACING: Readonly<Record<WidthClass, GridSpacing>> = {
  compact: { gutter: 20, gap: 8 },
  regular: { gutter: 32, gap: 12 },
  wide: { gutter: 48, gap: 12 },
};

const GRID_POSTER_MIN = 150;

/**
 * How many columns of posters fit a window `width` points wide: as many as stay 150 points wide,
 * and never fewer than an iPhone's three.
 */
export const gridColumns = (width: number, spacing: GridSpacing): number =>
  Math.max(
    3,
    Math.floor((width - 2 * spacing.gutter + spacing.gap) / (GRID_POSTER_MIN + spacing.gap)),
  );

type GridCell =
  | { readonly kind: "title"; readonly title: TitleCard }
  | { readonly kind: "blank"; readonly key: string };

/** One row of a grid and the key that names it. */
export interface GridRow {
  readonly key: string;
  readonly cells: ReadonlyArray<GridCell>;
}

/** The rows of a grid of `titles` in `columns` columns, the last padded with blanks to a whole row. */
export const gridRows = (
  titles: ReadonlyArray<TitleCard>,
  columns: number,
): ReadonlyArray<GridRow> => {
  const blanks = (columns - (titles.length % columns)) % columns;

  const cells = [
    ...titles.map((title): GridCell => ({ kind: "title", title })),
    ...Array.from({ length: blanks }, (_, index): GridCell => ({
      kind: "blank",
      key: `blank-${index}`,
    })),
  ];

  return Array.from({ length: cells.length / columns }, (_, row) => {
    const slice = cells.slice(row * columns, (row + 1) * columns);

    return {
      key: slice.map((cell) => (cell.kind === "title" ? cell.title.id : cell.key)).join(),
      cells: slice,
    };
  });
};

/** The titles a person is credited on, once each, in the order the server lists them. */
export const creditedTitles = (
  credits: ReadonlyArray<{ readonly title: TitleCard }>,
): ReadonlyArray<TitleCard> => {
  const seen = new Set<TitleId>();

  return credits.flatMap((credit) => {
    if (seen.has(credit.title.id)) return [];

    seen.add(credit.title.id);

    return [credit.title];
  });
};
