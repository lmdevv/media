import { ProfileId, TitleId } from "@media/contracts/ids";
import { Episode, Library, Progress, TitleCard } from "@media/contracts/models/catalog";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTERS,
  ofKind,
  creditedTitles,
  GRID_SPACING,
  gridRows,
  gridColumns,
  heroFacts,
  heroTitles,
  homeLayout,
  homeScreen,
  kindFacts,
  librariesFor,
  listArgs,
  newestFirst,
  playTarget,
  popularTitles,
  titleCount,
  watchStates,
} from "./browse";

const card = (
  id: string,
  overrides: Partial<Schema.Codec.Encoded<typeof TitleCard>> = {},
): TitleCard =>
  Schema.decodeSync(TitleCard)({
    id,
    kind: "movie",
    name: id,
    year: 2024,
    certification: "PG-13",
    ageRating: null,
    runtimeMs: 166 * 60_000,
    genres: ["Sci-Fi"],
    artwork: { poster: `${id}-poster`, backdrop: `${id}-backdrop`, logo: null },
    available: true,
    addedAt: 0,
    ...overrides,
  });

const library = (kind: "movies" | "shows" | "mixed", scanning = false): Library =>
  Schema.decodeSync(Library)({
    id: `library-${kind}`,
    name: kind,
    kind,
    titleCount: 0,
    lastScanAt: null,
    scanning,
  });

const progress = (positionMs: number, watched = false) =>
  Schema.decodeSync(Progress)({ positionMs, durationMs: 3_600_000, watched, updatedAt: 0 });

const episode = (positionMs: number | null) =>
  Schema.decodeSync(Episode)({
    id: "episode-3",
    titleId: "severance",
    seasonId: "season-2",
    seasonNumber: 2,
    episodeNumber: 3,
    name: "Who Is Alive?",
    overview: null,
    airDate: null,
    runtimeMs: null,
    still: null,
    rating: null,
    externalIds: { tmdb: null, imdb: null, tvdb: null },
    available: true,
    progress:
      positionMs === null
        ? null
        : { positionMs, durationMs: 3_600_000, watched: false, updatedAt: 0 },
  });

const home = (featured: TitleCard | null, arrived: number) => ({
  featured,
  continueWatching: [],
  myList: [],
  recentlyAddedMovies: Array.from({ length: arrived }, (_, index) => card(`movie-${index}`)),
  recentlyAddedShows: [],
});

const decodeTitleId = Schema.decodeSync(TitleId);

const decodeProfileId = Schema.decodeSync(ProfileId);

const severance = decodeTitleId("severance");

const kinds = (rows: ReturnType<typeof gridRows>) =>
  rows.map((row) => row.cells.map((cell) => cell.kind));

describe("browse", () => {
  it("pages the hero through the featured title, then new arrivals with wide artwork", () => {
    const featured = card("dune");

    const pages = heroTitles(featured, [
      card("dune"),
      card("no-backdrop", { artwork: { poster: null, backdrop: null, logo: null } }),
      ...Array.from({ length: 6 }, (_, index) => card(`new-${index}`)),
    ]);

    expect(pages.map((page) => page.id)).toEqual(["dune", "new-0", "new-1", "new-2", "new-3"]);
    expect(heroTitles(null, [])).toEqual([]);
  });

  it("orders arrivals newest first", () => {
    const titles = newestFirst(
      [card("movie-new", { addedAt: 4 }), card("movie-old", { addedAt: 1 })],
      [card("show-new", { addedAt: 3 }), card("show-old", { addedAt: 2 })],
    );

    expect(titles.map((title) => title.id)).toEqual([
      "movie-new",
      "show-new",
      "show-old",
      "movie-old",
    ]);
  });

  it("writes the hero facts with seasons for shows and running time for movies", () => {
    expect(heroFacts(card("dune"), null)).toBe("Sci-Fi · 2h 46m · PG-13");

    const show = card("severance", { kind: "show", genres: ["Thriller"], certification: "TV-MA" });

    expect(heroFacts(show, 2)).toBe("Thriller · 2 seasons · TV-MA");
    expect(heroFacts(show, 1)).toBe("Thriller · 1 season · TV-MA");
    expect(heroFacts(show, null)).toBe("Thriller · 2024 · TV-MA");
  });

  it("plays, resumes, or starts the next episode", () => {
    expect(playTarget(severance, null)).toEqual({ label: "Play", href: "/watch/severance" });

    expect(
      playTarget(severance, { kind: "movie", progress: progress(600_000), nextEpisode: null }),
    ).toEqual({ label: "Resume", href: "/watch/severance" });

    expect(
      playTarget(severance, {
        kind: "movie",
        progress: progress(600_000, true),
        nextEpisode: null,
      }),
    ).toEqual({ label: "Play", href: "/watch/severance" });

    expect(
      playTarget(severance, { kind: "show", progress: null, nextEpisode: episode(120_000) }),
    ).toEqual({ label: "Resume S2:E3", href: "/watch/severance?episodeId=episode-3" });

    expect(
      playTarget(severance, { kind: "show", progress: null, nextEpisode: episode(null) }),
    ).toEqual({ label: "Play S2:E3", href: "/watch/severance?episodeId=episode-3" });
  });

  it("picks Home's layout from libraries, scans, and what arrived", () => {
    expect(homeLayout(home(null, 0), [])).toBe("empty");
    expect(homeLayout(home(card("dune"), 3), [library("movies", true)])).toBe("scanning");
    expect(homeLayout(home(card("dune"), 8), [library("movies", true)])).toBe("rows");
    expect(homeLayout(home(null, 0), [library("movies")])).toBe("nothing");
    expect(homeLayout(home(card("dune"), 1), [library("movies")])).toBe("rows");
  });

  it("fills Home's top with the hero only for rows on a profile that isn't Kids", () => {
    const rows = home(card("dune"), 2);

    expect(homeScreen(rows, [library("movies")], false)).toMatchObject({
      layout: "rows",
      fullBleed: true,
    });
    expect(homeScreen(rows, [library("movies")], true).fullBleed).toBe(false);
    expect(homeScreen(home(null, 0), [], false)).toMatchObject({
      layout: "empty",
      fullBleed: false,
    });
    expect(homeScreen(rows, [library("movies")], false).pages.map((page) => page.id)).toEqual([
      "dune",
      "movie-0",
      "movie-1",
    ]);
  });

  it("offers the libraries that hold a kind", () => {
    const all = [library("movies"), library("shows"), library("mixed")];

    expect(librariesFor(all, "movie").map((entry) => entry.kind)).toEqual(["movies", "mixed"]);
    expect(librariesFor(all, "show").map((entry) => entry.kind)).toEqual(["shows", "mixed"]);
  });

  it("turns the grid's filters into list arguments", () => {
    const profileId = decodeProfileId("alex");

    expect(listArgs(profileId, "movie", DEFAULT_FILTERS, null, 60)).toEqual({
      profileId,
      kind: "movie",
      sort: "added",
      cursor: null,
      limit: 60,
    });

    const narrowed = { sort: "name" as const, genre: "Drama", libraryId: library("movies").id };

    expect(listArgs(profileId, null, narrowed, "next", 60)).toEqual({
      profileId,
      sort: "name",
      genre: "Drama",
      libraryId: "library-movies",
      cursor: "next",
      limit: 60,
    });
  });

  it("counts a collection by kind", () => {
    expect(titleCount([card("a"), card("b")])).toBe("2 movies");
    expect(titleCount([card("a", { kind: "show" })])).toBe("1 show");
    expect(titleCount([card("a"), card("b", { kind: "show" })])).toBe("2 titles");
    expect(kindFacts(card("a"))).toBe("Movie · 2024");
  });

  it("reads watch states from history", () => {
    const states = watchStates([
      { title: card("dune"), episode: null, progress: progress(3_600_000, true) },
      { title: card("arrival"), episode: null, progress: progress(60_000) },
      { title: card("severance", { kind: "show" }), episode: episode(0), progress: progress(0) },
    ]);

    expect(states.get(decodeTitleId("dune"))).toBe("watched");
    expect(states.get(decodeTitleId("arrival"))).toBe("started");
    expect(states.get(severance)).toBe("started");
    expect(states.has(decodeTitleId("missing"))).toBe(false);

    const show = card("severance", { kind: "show" });

    const finished = watchStates([
      { title: show, episode: episode(0), progress: progress(3_600_000, true) },
      { title: show, episode: episode(0), progress: progress(3_600_000, true) },
    ]);

    expect(finished.get(severance)).toBe("watched");

    const partway = watchStates([
      { title: show, episode: episode(0), progress: progress(3_600_000, true) },
      { title: show, episode: episode(0), progress: progress(60_000) },
      { title: show, episode: episode(0), progress: progress(3_600_000, true) },
    ]);

    expect(partway.get(severance)).toBe("started");
  });

  it("splits a grid into whole rows", () => {
    expect(gridRows([], 3)).toEqual([]);
    expect(kinds(gridRows([card("a")], 3))).toEqual([["title", "blank", "blank"]]);
    expect(kinds(gridRows([card("a"), card("b"), card("c"), card("d")], 3))).toEqual([
      ["title", "title", "title"],
      ["title", "blank", "blank"],
    ]);
    expect(gridRows([card("a"), card("b")], 7)[0]?.cells.length).toBe(7);
  });

  it("keeps an iPhone's three grid columns and fills an iPad's width", () => {
    expect(gridColumns(375, GRID_SPACING.compact)).toBe(3);
    expect(gridColumns(440, GRID_SPACING.compact)).toBe(3);
    expect(gridColumns(744, GRID_SPACING.regular)).toBe(4);
    expect(gridColumns(1032, GRID_SPACING.regular)).toBe(6);
    expect(gridColumns(1376, GRID_SPACING.wide)).toBe(7);
  });

  it("lists each credited title once", () => {
    const dune = card("dune");

    expect(
      creditedTitles([{ title: dune }, { title: card("arrival") }, { title: dune }]).map(
        (title) => title.id,
      ),
    ).toEqual(["dune", "arrival"]);
  });

  it("narrows a list to one kind", () => {
    const titles = [card("a"), card("b", { kind: "show" })];

    expect(ofKind(titles, "all").length).toBe(2);
    expect(ofKind(titles, "show").map((title) => title.id)).toEqual(["b"]);
  });

  it("offers what is being watched, then the list, then arrivals, each once", () => {
    const rows = {
      ...home(null, 0),
      continueWatching: [
        { reason: "resume" as const, title: card("dune"), episode: null, progress: null },
      ],
      myList: [card("arrival"), card("dune")],
      recentlyAddedMovies: [card("arrival", { addedAt: 2 }), card("heat", { addedAt: 1 })],
      recentlyAddedShows: [card("severance", { kind: "show", addedAt: 3 })],
    };

    expect(popularTitles(rows, 10).map((title) => title.id)).toEqual([
      "dune",
      "arrival",
      "severance",
      "heat",
    ]);
    expect(popularTitles(rows, 2).map((title) => title.id)).toEqual(["dune", "arrival"]);
  });
});
