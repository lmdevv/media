import { getDocumentSize } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  DOCUMENT_BYTES,
  fitCollection,
  fitCredit,
  fitEpisode,
  fitPerson,
  fitTitle,
} from "../../convex/movies/fit";

type Table = "libraries" | "titles" | "seasons" | "people";

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
