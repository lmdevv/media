import { Episode, MediaVersion, Progress, TitleDetail } from "@media/contracts/models/catalog";
import type { CreditKind } from "@media/contracts/models/catalog";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  aboutRows,
  castAndCrew,
  defaultVersion,
  episodeLine,
  episodeSubtitle,
  formatLongDate,
  initialSeason,
  optimisticValue,
  playAction,
  resumeOf,
  seasonDetail,
  titleFacts,
  watchedMarks,
} from "./title-model";

const MINUTE = 60_000;

const NO_IDS = { tmdb: null, imdb: null, tvdb: null };

const progress = (positionMin: number, durationMin: number, watched = false) => ({
  positionMs: positionMin * MINUTE,
  durationMs: durationMin * MINUTE,
  watched,
  updatedAt: 0,
});

const episode = (overrides: Partial<Schema.Codec.Encoded<typeof Episode>> = {}): Episode =>
  Schema.decodeSync(Episode)({
    id: "e3",
    titleId: "show",
    seasonId: "s2",
    seasonNumber: 2,
    episodeNumber: 3,
    name: "Who Is Alive?",
    overview: null,
    airDate: null,
    runtimeMs: 53 * MINUTE,
    still: null,
    rating: null,
    externalIds: NO_IDS,
    available: true,
    progress: null,
    ...overrides,
  });

const version = (
  overrides: Partial<Schema.Codec.Encoded<typeof MediaVersion>> = {},
): Schema.Codec.Encoded<typeof MediaVersion> => ({
  id: "f1",
  versionName: null,
  width: 3840,
  height: 2160,
  hdr: "hdr10",
  videoCodec: "hevc",
  videoProfile: null,
  videoLevel: null,
  videoBitDepth: 10,
  audioCodec: "eac3",
  audioChannels: 6,
  audioTracks: 1,
  container: "mkv",
  sizeBytes: 18_400_000_000,
  durationMs: 166 * MINUTE,
  lastPlayed: false,
  ...overrides,
});

const season = (seasonNumber: number, episodeCount: number) => ({
  id: `s${seasonNumber}`,
  seasonNumber,
  name: `Season ${seasonNumber}`,
  poster: null,
  episodeCount,
  externalIds: NO_IDS,
});

const credit = (personId: string, name: string, kind: CreditKind, role: string | null = null) => ({
  personId,
  name,
  kind,
  role,
  profile: null,
  order: 0,
});

const movie = (overrides: Partial<Schema.Codec.Encoded<typeof TitleDetail>> = {}): TitleDetail =>
  Schema.decodeSync(TitleDetail)({
    id: "dune",
    kind: "movie",
    name: "Dune: Part Two",
    year: 2024,
    certification: "PG-13",
    ageRating: null,
    runtimeMs: 166 * MINUTE,
    genres: ["Science Fiction", "Adventure"],
    artwork: { poster: null, backdrop: null, logo: null },
    available: true,
    addedAt: 0,
    libraryId: "lib",
    sortName: "Dune: Part Two",
    overview: "Paul Atreides unites with Chani.",
    tagline: null,
    externalIds: NO_IDS,
    matchStatus: "matched",
    originalName: null,
    releaseDate: "2024-03-01",
    status: null,
    originalLanguage: "en",
    studios: ["Legendary Pictures"],
    countries: [],
    tags: [],
    ratings: { tmdb: { value: 8.15, votes: 10 }, imdb: null, rottenTomatoes: 92, metacritic: null },
    trailer: null,
    collection: null,
    cast: [],
    crew: [],
    seasons: [],
    files: [],
    versions: [version()],
    progress: null,
    nextEpisode: null,
    inMyList: false,
    ...overrides,
  });

const show = (overrides: Partial<Schema.Codec.Encoded<typeof TitleDetail>> = {}): TitleDetail =>
  movie({
    id: "show",
    kind: "show",
    name: "Severance",
    genres: ["Thriller"],
    certification: "TV-MA",
    runtimeMs: null,
    versions: [],
    releaseDate: null,
    year: 2022,
    status: "returning",
    studios: ["Apple TV+"],
    seasons: [season(1, 9), season(2, 10)],
    nextEpisode: Schema.encodeSync(Episode)(episode()),
    ...overrides,
  });

describe("playAction", () => {
  it("plays an unstarted or finished movie and resumes a started one with the time left", () => {
    expect(playAction(movie())).toEqual({
      label: "Play",
      episodeId: undefined,
      resuming: false,
      available: true,
    });
    expect(playAction(movie({ progress: progress(166, 166, true) })).label).toBe("Play");
    expect(playAction(movie({ progress: progress(94, 166) }))).toEqual({
      label: "Resume · 1h 12m left",
      episodeId: undefined,
      resuming: true,
      available: true,
    });
  });

  it("names the show's next episode, resumed when started", () => {
    expect(playAction(show())).toEqual({
      label: "Play · S2, E3",
      episodeId: "e3",
      resuming: false,
      available: true,
    });

    const started = show({
      nextEpisode: Schema.encodeSync(Episode)(episode({ progress: progress(15, 53) })),
    });

    expect(playAction(started).label).toBe("Resume · S2, E3");
    expect(playAction(started).resuming).toBe(true);
    expect(playAction(show({ nextEpisode: null })).label).toBe("Play");
  });
});

describe("titleFacts", () => {
  it("writes a movie's year, runtime, rating, and best picture", () => {
    expect(titleFacts(movie())).toBe("2024 · 2h 46m · PG-13 · 4K");
    expect(titleFacts(movie({ versions: [], certification: null }))).toBe("2024 · 2h 46m");
  });

  it("writes a show's genre, seasons, and rating", () => {
    expect(titleFacts(show())).toBe("Thriller · 2 seasons · TV-MA");
    expect(titleFacts(show({ seasons: [season(1, 8)] }))).toBe("Thriller · 1 season · TV-MA");
  });
});

describe("playAction availability", () => {
  it("follows the next episode's file for shows and the title's for movies", () => {
    expect(playAction(movie({ available: false })).available).toBe(false);
    expect(
      playAction(show({ nextEpisode: Schema.encodeSync(Episode)(episode({ available: false })) }))
        .available,
    ).toBe(false);
  });
});

describe("watchedMarks", () => {
  it("offers a movie the mark it lacks", () => {
    expect(watchedMarks(movie({ progress: progress(166, 166, true) }))).toEqual({
      markWatched: false,
      markUnwatched: true,
    });
    expect(watchedMarks(movie())).toEqual({ markWatched: true, markUnwatched: false });
  });

  it("always offers a show Mark as Watched, and Mark as Unwatched once it is started", () => {
    const first = Schema.encodeSync(Episode)(episode({ seasonNumber: 1, episodeNumber: 1 }));

    expect(watchedMarks(show({ nextEpisode: first }))).toEqual({
      markWatched: true,
      markUnwatched: false,
    });
    expect(watchedMarks(show()).markUnwatched).toBe(true);
    expect(
      watchedMarks(
        show({
          nextEpisode: Schema.encodeSync(Episode)(
            episode({ seasonNumber: 1, episodeNumber: 1, progress: progress(5, 53) }),
          ),
        }),
      ).markUnwatched,
    ).toBe(true);
    expect(watchedMarks(show({ nextEpisode: null }))).toEqual({
      markWatched: true,
      markUnwatched: true,
    });
    expect(watchedMarks(show({ nextEpisode: null, seasons: [] })).markUnwatched).toBe(false);
  });
});

describe("episode rows", () => {
  it("shows the runtime, the time left, a watched line, or a missing file", () => {
    expect(episodeLine(episode())).toEqual({
      heading: "3. Who Is Alive?",
      meta: "53m",
      watched: false,
    });
    expect(episodeLine(episode({ progress: progress(15, 53) })).meta).toBe("53m · 38m left");
    expect(episodeLine(episode({ progress: progress(53, 53, true) }))).toMatchObject({
      meta: "53m",
      watched: true,
    });
    expect(episodeLine(episode({ available: false })).meta).toBe("53m · File missing");
  });

  it("names the season and episode under an episode's actions", () => {
    expect(episodeSubtitle(episode())).toBe("Season 2, Episode 3 · 53m");
  });
});

describe("seasons", () => {
  it("counts episodes and marks the selected season", () => {
    const [first, second] = show().seasons;

    expect(first === undefined ? null : seasonDetail(first, false)).toBe("9 Episodes");
    expect(second === undefined ? null : seasonDetail(second, true)).toBe("10 Episodes · Selected");
  });

  it("opens on the next episode's season, else the first", () => {
    expect(initialSeason(show())).toBe(2);
    expect(initialSeason(show({ nextEpisode: null }))).toBe(1);
    expect(initialSeason(movie())).toBeNull();
    expect(initialSeason(show({ nextEpisode: null, seasons: [season(0, 3), season(1, 9)] }))).toBe(
      1,
    );
    expect(initialSeason(show({ nextEpisode: null, seasons: [season(0, 3)] }))).toBe(0);
  });
});

describe("defaultVersion", () => {
  it("offers the last played version, else the best", () => {
    const versions = Schema.decodeSync(Schema.Array(MediaVersion))([
      version({ id: "best" }),
      version({ id: "played", lastPlayed: true }),
    ]);

    expect(defaultVersion(versions)?.id).toBe("played");
    expect(defaultVersion(versions.slice(0, 1))?.id).toBe("best");
    expect(defaultVersion([])).toBeUndefined();
  });
});

describe("resumeOf", () => {
  it("resumes only started, unfinished items, never past the end", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        fc.boolean(),
        (position, duration, watched) => {
          const resume = resumeOf(
            Schema.decodeSync(Progress)(progress(position, duration, watched)),
          );

          if (watched || position === 0 || duration === 0) {
            expect(resume).toBeNull();
          } else {
            expect(resume?.remainingMs).toBe(Math.max(0, duration - position) * MINUTE);
          }
        },
      ),
    );
  });
});

describe("formatLongDate", () => {
  it("writes ISO dates out and leaves anything else alone", () => {
    expect(formatLongDate("2024-03-01")).toBe("March 1, 2024");
    expect(formatLongDate("1999-12-31")).toBe("December 31, 1999");
    expect(formatLongDate("2024-13-01")).toBe("2024-13-01");
    expect(formatLongDate("soon")).toBe("soon");
  });
});

describe("aboutRows", () => {
  it("lists a movie's facts, scores, and crew, skipping what it lacks", () => {
    const rows = aboutRows(
      movie({
        crew: [
          credit("p1", "Denis Villeneuve", "director"),
          credit("p1", "Denis Villeneuve", "writer"),
          credit("p2", "Jon Spaihts", "writer"),
          credit("p3", "Hans Zimmer", "composer"),
        ],
      }),
    );

    expect(rows).toEqual([
      { label: "Released", value: "March 1, 2024" },
      { label: "Duration", value: "2h 46m" },
      { label: "Genres", value: "Science Fiction, Adventure" },
      { label: "Rating", value: "PG-13" },
      { label: "Studio", value: "Legendary Pictures" },
      { label: "Scores", value: "RT 92% · TMDB 8.2" },
      { label: "Directed by", value: "Denis Villeneuve" },
      { label: "Written by", value: "Denis Villeneuve, Jon Spaihts" },
      { label: "Music by", value: "Hans Zimmer" },
    ]);
  });

  it("lists a show's first air year, seasons, status, and network", () => {
    expect(
      aboutRows(
        show({ ratings: { tmdb: null, imdb: null, rottenTomatoes: null, metacritic: null } }),
      ),
    ).toEqual([
      { label: "First Aired", value: "2022" },
      { label: "Seasons", value: "2 Seasons · 19 Episodes" },
      { label: "Genre", value: "Thriller" },
      { label: "Rating", value: "TV-MA" },
      { label: "Status", value: "Returning Series" },
      { label: "Network", value: "Apple TV+" },
    ]);
  });
});

describe("castAndCrew", () => {
  it("lists the billed cast, then creators and directors, each person once", () => {
    const people = castAndCrew(
      movie({
        cast: [
          credit("a1", "Timothée Chalamet", "actor", "Paul Atreides"),
          credit("a2", "Zendaya", "actor", "Chani"),
        ],
        crew: [
          credit("d1", "Denis Villeneuve", "director"),
          credit("d1", "Denis Villeneuve", "writer"),
          credit("a2", "Zendaya", "director"),
          credit("c1", "Hans Zimmer", "composer"),
        ],
      }),
    );

    expect(people.map((person) => [person.name, person.role])).toEqual([
      ["Timothée Chalamet", "Paul Atreides"],
      ["Zendaya", "Chani"],
      ["Denis Villeneuve", "Director"],
    ]);
  });
});

describe("optimisticValue", () => {
  it("shows the change until the server moves off its base, then spends it", () => {
    const pending = { from: false, to: true };

    expect(optimisticValue(null, false)).toEqual({ value: false, spent: false });
    expect(optimisticValue(pending, false)).toEqual({ value: true, spent: false });
    expect(optimisticValue(pending, true)).toEqual({ value: true, spent: true });
  });

  it("never revives a spent change: once dropped, the server's value shows", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(fc.boolean()), (from, serverValues) => {
        let pending: { from: boolean; to: boolean } | null = { from, to: !from };

        for (const server of serverValues) {
          const shown = optimisticValue(pending, server);

          if (shown.spent) pending = null;

          if (pending === null) expect(shown.value).toBe(server);
        }
      }),
    );
  });
});
