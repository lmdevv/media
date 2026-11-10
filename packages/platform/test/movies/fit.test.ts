import { getDocumentSize } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../../convex/_generated/dataModel";
import { BOUNDS } from "../../convex/movies/bounds";
import {
  DOCUMENT_BYTES,
  SHORTEST,
  fitCollection,
  fitCredit,
  fitEpisode,
  fitGenreRow,
  fitPerson,
  fitTitle,
} from "../../convex/movies/fit";

type Table =
  | "libraries"
  | "titles"
  | "seasons"
  | "episodes"
  | "people"
  | "collections"
  | "mediaFiles"
  | "users";

// SAFETY: a type predicate, not checked by the compiler. These tests read no table; the strings
// only stand in for ids, and no validator sees them.
const isId =
  <T extends Table>(_table: T) =>
  (value: string): value is Id<T> =>
    value.length > 0;

const idOf = <T extends Table>(table: T, raw: string): Id<T> => {
  if (!isId(table)(raw)) throw new Error("no id");

  return raw;
};

const libraryId = idOf("libraries", "k57libraryidforafittestxxxxxxxxx");

const NO_IDS = { tmdb: null, imdb: null, tvdb: null };

const huge = (length: number) => "Plot ".repeat(length).slice(0, length);

const title = (
  overview: string,
  genres: ReadonlyArray<string>,
): WithoutSystemFields<Doc<"titles">> => ({
  libraryId,
  kind: "movie",
  matchKey: "nfo:a very specific match key",
  name: "A Title",
  sortName: "A Title",
  sortKey: "a title",
  year: 2010,
  overview,
  tagline: null,
  genres: [...genres],
  certification: null,
  ageRating: 7,
  runtimeMs: null,
  artwork: { poster: null, backdrop: null, logo: null },
  externalIds: NO_IDS,
  matchStatus: "matched",
  presentFileCount: 1,
  episodeCount: 0,
  matchGeneration: 0,
  addedAt: 1,
  updatedAt: 1,
  searchText: "A Title 2010",
});

describe("movies document bounds", () => {
  it("leave a title within its bound untouched", () => {
    const small = title("A short plot.", ["Drama"]);

    expect(fitTitle(small)).toBe(small);
  });

  it("cut an absurd overview until the title fits, keeping its identity", () => {
    const big = title(huge(600_000), ["Drama"]);
    const fitted = fitTitle(big);

    expect(getDocumentSize(fitted)).toBeLessThanOrEqual(DOCUMENT_BYTES.titles);
    expect(fitted.overview?.startsWith("Plot Plot")).toBe(true);
    expect(fitted).toMatchObject({
      libraryId,
      kind: "movie",
      matchKey: big.matchKey,
      name: "A Title",
      genres: ["Drama"],
      ageRating: 7,
    });
  });

  it("shorten a title's lists once no text can shrink", () => {
    const genres = Array.from({ length: 4000 }, (_, n) => `Genre ${n}`);
    const fitted = fitTitle(title("A short plot.", genres));

    expect(getDocumentSize(fitted)).toBeLessThanOrEqual(DOCUMENT_BYTES.titles);
    expect(fitted.genres.length).toBeGreaterThan(0);
    expect(fitted.genres).toEqual(genres.slice(0, fitted.genres.length));
  });

  it("bound episodes, people, credits, and collections the same way", () => {
    const titleId = idOf("titles", "k57titleidforafittestxxxxxxxxxxx");
    const seasonId = idOf("seasons", "k57seasonidforafittestxxxxxxxxxx");
    const personId = idOf("people", "k57personidforafittestxxxxxxxxxx");

    const episode = fitEpisode({
      titleId,
      seasonId,
      seasonNumber: 1,
      episodeNumber: 1,
      name: "Pilot",
      overview: huge(100_000),
      airDate: null,
      runtimeMs: null,
      still: null,
      presentFileCount: 1,
      rating: null,
      externalIds: NO_IDS,
    });

    const person = fitPerson({
      personKey: "name:a person",
      name: "A Person",
      sortKey: "person a",
      externalIds: NO_IDS,
      profile: null,
      biography: huge(100_000),
      birthDate: null,
      deathDate: null,
      birthPlace: null,
      knownFor: null,
      detailsFetchedAt: null,
      updatedAt: 1,
    });

    const credit = fitCredit({
      titleId,
      episodeId: null,
      personId,
      kind: "actor",
      role: huge(10_000),
      order: 0,
    });

    const collection = fitCollection({
      name: "A Set",
      sortKey: "a set",
      sourceKey: "set:a set",
      createdAt: 1,
      updatedAt: 1,
      overview: huge(100_000),
      poster: null,
      backdrop: null,
    });

    expect(getDocumentSize(episode)).toBeLessThanOrEqual(DOCUMENT_BYTES.episodes);
    expect(getDocumentSize(person)).toBeLessThanOrEqual(DOCUMENT_BYTES.people);
    expect(getDocumentSize(credit)).toBeLessThanOrEqual(DOCUMENT_BYTES.credits);
    expect(getDocumentSize(collection)).toBeLessThanOrEqual(DOCUMENT_BYTES.collections);
    expect([episode.name, person.personKey, credit.kind, collection.sourceKey]).toEqual([
      "Pilot",
      "name:a person",
      "actor",
      "set:a set",
    ]);
  });
});

/** A character UTF-8 spends 3 bytes on in one UTF-16 code unit: the most bytes per unit. */
const WIDE = "\u20AC";

/** `length` code units of the widest text: a field at its bound, at its most bytes. */
const wide = (length: number) => WIDE.repeat(length);

const ids = {
  titleId: idOf("titles", "k57titleidforaboundtestxxxxxxxxx"),
  seasonId: idOf("seasons", "k57seasonidforaboundtestxxxxxxxx"),
  episodeId: idOf("episodes", "k57episodeidforaboundtestxxxxxxx"),
  personId: idOf("people", "k57personidforaboundtestxxxxxxxx"),
  collectionId: idOf("collections", "k57collectionidforaboundtestxxxx"),
  fileId: idOf("mediaFiles", "k57fileidforaboundtestxxxxxxxxxx"),
  userId: idOf("users", "k57useridforaboundtestxxxxxxxxxx"),
};

const widestIds = { tmdb: wide(BOUNDS.id), imdb: wide(BOUNDS.id), tvdb: wide(BOUNDS.id) };

/**
 * Each kind of document at the smallest a fitter can leave it while every field it never cuts is
 * at its maximum: identity fields at their bounds, free text at `SHORTEST`, lists empty, every
 * optional field present, all in the widest characters. If these fit, a fitter that cuts free
 * text to `SHORTEST` and then empties lists always reaches its target.
 */
interface Floor {
  readonly title: WithoutSystemFields<Doc<"titles">>;
  readonly episode: WithoutSystemFields<Doc<"episodes">>;
  readonly person: WithoutSystemFields<Doc<"people">>;
  readonly credit: WithoutSystemFields<Doc<"credits">>;
  readonly collection: WithoutSystemFields<Doc<"collections">>;
}

const floor = (text: number): Floor => {
  const free = wide(text);

  return {
    title: {
      ...title(free, []),
      matchKey: wide(BOUNDS.key),
      name: free,
      sortName: free,
      sortKey: free,
      tagline: free,
      certification: free,
      searchText: free,
      artwork: { poster: free, backdrop: free, logo: free },
      externalIds: widestIds,
      overrides: {
        name: free,
        sortName: free,
        year: 2010,
        overview: free,
        certification: free,
        ageRating: 21,
      },
      originalName: free,
      releaseDate: free,
      status: "in-production",
      originalLanguage: free,
      studios: [],
      countries: [],
      tags: [],
      ratings: {
        tmdb: { value: 7.25, votes: 1_000_000 },
        imdb: { value: 7.25, votes: 1_000_000 },
        rottenTomatoes: 99,
        metacritic: 99,
      },
      trailer: { site: "youtube", key: wide(BOUNDS.id), name: free },
      recommendations: [],
      creditsHash: wide(BOUNDS.digest),
      collectionHash: wide(BOUNDS.digest),
      purging: true,
    },
    episode: {
      titleId: ids.titleId,
      seasonId: ids.seasonId,
      seasonNumber: 1,
      episodeNumber: 1,
      name: free,
      overview: free,
      airDate: free,
      runtimeMs: 3_600_000,
      still: free,
      presentFileCount: 1,
      rating: { value: 7.25, votes: 1_000_000 },
      externalIds: widestIds,
      creditsHash: wide(BOUNDS.digest),
    },
    person: {
      personKey: wide(BOUNDS.key),
      name: free,
      sortKey: free,
      externalIds: widestIds,
      profile: free,
      biography: free,
      birthDate: free,
      deathDate: free,
      birthPlace: free,
      knownFor: free,
      detailsFetchedAt: 1,
      detailsRequestedAt: 1,
      updatedAt: 1,
    },
    credit: {
      titleId: ids.titleId,
      episodeId: ids.episodeId,
      personId: ids.personId,
      kind: "guest-star",
      role: free,
      order: 1_000_000,
    },
    collection: {
      name: free,
      sortKey: free,
      sourceKey: wide(BOUNDS.sourceKey),
      createdAt: 1,
      updatedAt: 1,
      overview: free,
      poster: free,
      backdrop: free,
    },
  };
};

describe("the movies fitters reach their targets", () => {
  it("fit every kind of document at its floor within its bound", () => {
    const smallest = floor(SHORTEST);

    expect(getDocumentSize(smallest.title)).toBeLessThanOrEqual(DOCUMENT_BYTES.titles);
    expect(getDocumentSize(smallest.episode)).toBeLessThanOrEqual(DOCUMENT_BYTES.episodes);
    expect(getDocumentSize(smallest.person)).toBeLessThanOrEqual(DOCUMENT_BYTES.people);
    expect(getDocumentSize(smallest.credit)).toBeLessThanOrEqual(DOCUMENT_BYTES.credits);
    expect(getDocumentSize(smallest.collection)).toBeLessThanOrEqual(DOCUMENT_BYTES.collections);
  });

  it("fit every small row at its bounds within the small bound", () => {
    const rows = [
      {
        titleId: ids.titleId,
        libraryId,
        genre: wide(BOUNDS.genre),
        kind: "movie",
        sortKey: wide(BOUNDS.genreSortKey),
        addedAt: 1,
        year: 2010,
      },
      {
        userId: ids.userId,
        titleId: ids.titleId,
        episodeId: ids.episodeId,
        fileId: ids.fileId,
        positionMs: 1,
        durationMs: 1,
        watched: true,
        updatedAt: 1,
        lastPlayedAt: 1,
        playId: wide(BOUNDS.playbackId),
        playStartedAt: 1,
      },
      { userId: ids.userId, titleId: ids.titleId, addedAt: 1 },
      { collectionId: ids.collectionId, titleId: ids.titleId, position: 1, source: "metadata" },
      { userId: ids.userId, titleId: ids.titleId, generation: 1_000_000 },
    ];

    for (const row of rows) expect(getDocumentSize(row)).toBeLessThanOrEqual(DOCUMENT_BYTES.small);
  });

  it("bring documents far past every bound within them, keeping ids that fit", () => {
    const absurd = floor(20_000);
    const genres = Array.from({ length: 2000 }, (_, n) => `${wide(200)} ${n}`);
    const kept = { tmdb: "603", imdb: wide(BOUNDS.id + 1), tvdb: wide(BOUNDS.id) };

    const fittedTitle = fitTitle({
      ...absurd.title,
      externalIds: kept,
      genres,
      studios: genres,
      countries: genres,
      tags: genres,
      recommendations: [wide(BOUNDS.id + 1), "550", wide(100_000)],
      matchKey: wide(BOUNDS.key * 4),
    });

    const fitted = [
      [fittedTitle, DOCUMENT_BYTES.titles],
      [fitEpisode({ ...absurd.episode, externalIds: kept }), DOCUMENT_BYTES.episodes],
      [fitPerson({ ...absurd.person, personKey: wide(100_000) }), DOCUMENT_BYTES.people],
      [fitCredit(absurd.credit), DOCUMENT_BYTES.credits],
      [
        fitCollection({ ...absurd.collection, sourceKey: wide(100_000) }),
        DOCUMENT_BYTES.collections,
      ],
      [
        fitGenreRow({
          titleId: ids.titleId,
          libraryId,
          genre: wide(BOUNDS.genre),
          kind: "movie",
          sortKey: wide(100_000),
          addedAt: 1,
          year: null,
        }),
        DOCUMENT_BYTES.small,
      ],
    ] as const;

    for (const [document, bound] of fitted) {
      expect(getDocumentSize(document)).toBeLessThanOrEqual(bound);
    }

    expect(fittedTitle.externalIds).toEqual({ tmdb: "603", imdb: null, tvdb: wide(BOUNDS.id) });
    expect(fittedTitle.matchKey).toBe(wide(BOUNDS.key));
    expect(fittedTitle.recommendations).toEqual(["550"]);
  });
});
