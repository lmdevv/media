import type { WithoutSystemFields } from "convex/server";
import { getDocumentSize } from "convex/values";

import type { Doc } from "../_generated/dataModel";

/**
 * The most bytes, as Convex measures a document, each kind of movies document is kept within by
 * its writers (ADR 0024). Reads reserve this much per document before they read and settle on
 * each document's real size after (ADR 0005), so a call never reads past Convex's limit however
 * long a title's text is.
 */
export const DOCUMENT_BYTES = {
  titles: 64 * 1024,
  episodes: 16 * 1024,
  people: 16 * 1024,
  credits: 2 * 1024,
  collections: 16 * 1024,
} as const;

/** The shortest a cut string becomes, longer than any id, literal, or key a writer stores. */
const SHORTEST = 64;

const points = (text: string): number => text.length;

/** A lead surrogate at the end, which a cut must not keep without its pair. */
const DANGLING = /[\uD800-\uDBFF]$/u;

/** `text` cut to half its length, never below `SHORTEST`, never inside a surrogate pair. */
const halved = (text: string): string => {
  const cut = text.slice(0, Math.max(SHORTEST, Math.floor(text.length / 2)));

  return DANGLING.test(cut) ? cut.slice(0, -1) : cut;
};

/** How much a string field can still give: its code points past `SHORTEST`, or none. */
const spare = (text: string | null | undefined): number =>
  text === null || text === undefined ? 0 : Math.max(0, points(text) - SHORTEST);

/** The longest string of a list cut in half, the others kept. */
const halvedLongest = (list: ReadonlyArray<string>): Array<string> => {
  const longest = list.reduce(
    (best, text, index) => (points(text) > points(list[best] ?? "") ? index : best),
    0,
  );

  return list.map((text, index) => (index === longest ? halved(text) : text));
};

const spareOf = (list: ReadonlyArray<string> | undefined): number =>
  Math.max(0, ...(list ?? []).map((text) => spare(text)));

/** One way to make a document smaller: how much it can still give, and the smaller document. */
interface Shrinker<Fields> {
  readonly spare: (fields: Fields) => number;
  readonly shrink: (fields: Fields) => Fields;
}

/**
 * `fields` kept within `maxBytes` as Convex measures their document: while it is larger, the
 * text shrinker with the most to give halves its string; once no text can shrink, the list
 * shrinker with the longest list drops its last element. It never fails a write.
 */
const fitWith = <Fields extends Parameters<typeof getDocumentSize>[0]>(
  fields: Fields,
  maxBytes: number,
  texts: ReadonlyArray<Shrinker<Fields>>,
  lists: ReadonlyArray<Shrinker<Fields>>,
): Fields => {
  if (getDocumentSize(fields) <= maxBytes) return fields;

  const pick = (shrinkers: ReadonlyArray<Shrinker<Fields>>) =>
    shrinkers.reduce<Shrinker<Fields> | undefined>(
      (best, one) =>
        one.spare(fields) > 0 && (best === undefined || one.spare(fields) > best.spare(fields))
          ? one
          : best,
      undefined,
    );

  const next = pick(texts) ?? pick(lists);

  return next === undefined ? fields : fitWith(next.shrink(fields), maxBytes, texts, lists);
};

type TitleFields = WithoutSystemFields<Doc<"titles">>;

const titleTexts = <Fields extends TitleFields>(): ReadonlyArray<Shrinker<Fields>> => [
  {
    spare: (f) => spare(f.overview),
    shrink: (f) => ({ ...f, overview: f.overview === null ? null : halved(f.overview) }),
  },
  {
    spare: (f) => spare(f.tagline),
    shrink: (f) => ({ ...f, tagline: f.tagline === null ? null : halved(f.tagline) }),
  },
  { spare: (f) => spare(f.name), shrink: (f) => ({ ...f, name: halved(f.name) }) },
  { spare: (f) => spare(f.sortName), shrink: (f) => ({ ...f, sortName: halved(f.sortName) }) },
  { spare: (f) => spare(f.sortKey), shrink: (f) => ({ ...f, sortKey: halved(f.sortKey) }) },
  {
    spare: (f) => spare(f.searchText),
    shrink: (f) => ({ ...f, searchText: halved(f.searchText) }),
  },
  {
    spare: (f) => spare(f.certification),
    shrink: (f) => ({
      ...f,
      certification: f.certification === null ? null : halved(f.certification),
    }),
  },
  {
    spare: (f) => spare(f.originalName),
    shrink: (f) => ({
      ...f,
      originalName:
        f.originalName === undefined || f.originalName === null
          ? f.originalName
          : halved(f.originalName),
    }),
  },
  {
    spare: (f) => spare(f.releaseDate),
    shrink: (f) => ({
      ...f,
      releaseDate:
        f.releaseDate === undefined || f.releaseDate === null
          ? f.releaseDate
          : halved(f.releaseDate),
    }),
  },
  {
    spare: (f) => spare(f.originalLanguage),
    shrink: (f) => ({
      ...f,
      originalLanguage:
        f.originalLanguage === undefined || f.originalLanguage === null
          ? f.originalLanguage
          : halved(f.originalLanguage),
    }),
  },
  {
    spare: (f) => spare(f.overrides?.overview),
    shrink: (f) =>
      f.overrides?.overview === undefined
        ? f
        : { ...f, overrides: { ...f.overrides, overview: halved(f.overrides.overview) } },
  },
  {
    spare: (f) => spare(f.overrides?.name),
    shrink: (f) =>
      f.overrides?.name === undefined
        ? f
        : { ...f, overrides: { ...f.overrides, name: halved(f.overrides.name) } },
  },
  {
    spare: (f) => spare(f.overrides?.sortName),
    shrink: (f) =>
      f.overrides?.sortName === undefined
        ? f
        : { ...f, overrides: { ...f.overrides, sortName: halved(f.overrides.sortName) } },
  },
  {
    spare: (f) => spare(f.overrides?.certification),
    shrink: (f) =>
      f.overrides?.certification === undefined
        ? f
        : { ...f, overrides: { ...f.overrides, certification: halved(f.overrides.certification) } },
  },
  {
    spare: (f) => spare(f.artwork.poster),
    shrink: (f) => ({
      ...f,
      artwork: {
        ...f.artwork,
        poster: f.artwork.poster === null ? null : halved(f.artwork.poster),
      },
    }),
  },
  {
    spare: (f) => spare(f.artwork.backdrop),
    shrink: (f) => ({
      ...f,
      artwork: {
        ...f.artwork,
        backdrop: f.artwork.backdrop === null ? null : halved(f.artwork.backdrop),
      },
    }),
  },
  {
    spare: (f) => spare(f.artwork.logo),
    shrink: (f) => ({
      ...f,
      artwork: { ...f.artwork, logo: f.artwork.logo === null ? null : halved(f.artwork.logo) },
    }),
  },
  {
    spare: (f) => spare(f.trailer?.name),
    shrink: (f) =>
      f.trailer === undefined || f.trailer === null || f.trailer.name === null
        ? f
        : { ...f, trailer: { ...f.trailer, name: halved(f.trailer.name) } },
  },
  { spare: (f) => spareOf(f.genres), shrink: (f) => ({ ...f, genres: halvedLongest(f.genres) }) },
  {
    spare: (f) => spareOf(f.tags),
    shrink: (f) => (f.tags === undefined ? f : { ...f, tags: halvedLongest(f.tags) }),
  },
  {
    spare: (f) => spareOf(f.studios),
    shrink: (f) => (f.studios === undefined ? f : { ...f, studios: halvedLongest(f.studios) }),
  },
  {
    spare: (f) => spareOf(f.countries),
    shrink: (f) =>
      f.countries === undefined ? f : { ...f, countries: halvedLongest(f.countries) },
  },
  {
    spare: (f) => spareOf(f.recommendations),
    shrink: (f) =>
      f.recommendations === undefined
        ? f
        : { ...f, recommendations: halvedLongest(f.recommendations) },
  },
];

const titleLists = <Fields extends TitleFields>(): ReadonlyArray<Shrinker<Fields>> => [
  { spare: (f) => f.genres.length, shrink: (f) => ({ ...f, genres: f.genres.slice(0, -1) }) },
  { spare: (f) => f.tags?.length ?? 0, shrink: (f) => ({ ...f, tags: f.tags?.slice(0, -1) }) },
  {
    spare: (f) => f.studios?.length ?? 0,
    shrink: (f) => ({ ...f, studios: f.studios?.slice(0, -1) }),
  },
  {
    spare: (f) => f.countries?.length ?? 0,
    shrink: (f) => ({ ...f, countries: f.countries?.slice(0, -1) }),
  },
  {
    spare: (f) => f.recommendations?.length ?? 0,
    shrink: (f) => ({ ...f, recommendations: f.recommendations?.slice(0, -1) }),
  },
];

/**
 * A title's fields kept within `DOCUMENT_BYTES.titles`: its longest free text halved first (an
 * overview, an admin's overview, a name), then its longest lists shortened. Its library, kind,
 * match key, ids, and numbers never change.
 */
export const fitTitle = <Fields extends TitleFields>(fields: Fields): Fields =>
  fitWith(fields, DOCUMENT_BYTES.titles, titleTexts<Fields>(), titleLists<Fields>());

type EpisodeFields = WithoutSystemFields<Doc<"episodes">>;

/** An episode's fields kept within `DOCUMENT_BYTES.episodes`: its overview, then its name. */
export const fitEpisode = <Fields extends EpisodeFields>(fields: Fields): Fields =>
  fitWith(
    fields,
    DOCUMENT_BYTES.episodes,
    [
      {
        spare: (f) => spare(f.overview),
        shrink: (f) => ({ ...f, overview: f.overview === null ? null : halved(f.overview) }),
      },
      { spare: (f) => spare(f.name), shrink: (f) => ({ ...f, name: halved(f.name) }) },
      {
        spare: (f) => spare(f.airDate),
        shrink: (f) => ({ ...f, airDate: f.airDate === null ? null : halved(f.airDate) }),
      },
      {
        spare: (f) => spare(f.still),
        shrink: (f) => ({ ...f, still: f.still === null ? null : halved(f.still) }),
      },
    ],
    [],
  );

type PersonFields = WithoutSystemFields<Doc<"people">>;

/** A person's fields kept within `DOCUMENT_BYTES.people`: their biography first. */
export const fitPerson = <Fields extends PersonFields>(fields: Fields): Fields =>
  fitWith(
    fields,
    DOCUMENT_BYTES.people,
    [
      {
        spare: (f) => spare(f.biography),
        shrink: (f) => ({ ...f, biography: f.biography === null ? null : halved(f.biography) }),
      },
      {
        spare: (f) => spare(f.knownFor),
        shrink: (f) => ({ ...f, knownFor: f.knownFor === null ? null : halved(f.knownFor) }),
      },
      {
        spare: (f) => spare(f.birthPlace),
        shrink: (f) => ({ ...f, birthPlace: f.birthPlace === null ? null : halved(f.birthPlace) }),
      },
      { spare: (f) => spare(f.name), shrink: (f) => ({ ...f, name: halved(f.name) }) },
      { spare: (f) => spare(f.sortKey), shrink: (f) => ({ ...f, sortKey: halved(f.sortKey) }) },
      {
        spare: (f) => spare(f.profile),
        shrink: (f) => ({ ...f, profile: f.profile === null ? null : halved(f.profile) }),
      },
      {
        spare: (f) => spare(f.birthDate),
        shrink: (f) => ({ ...f, birthDate: f.birthDate === null ? null : halved(f.birthDate) }),
      },
      {
        spare: (f) => spare(f.deathDate),
        shrink: (f) => ({ ...f, deathDate: f.deathDate === null ? null : halved(f.deathDate) }),
      },
    ],
    [],
  );

type CreditFields = WithoutSystemFields<Doc<"credits">>;

/** A credit's fields kept within `DOCUMENT_BYTES.credits`: its role. */
export const fitCredit = <Fields extends CreditFields>(fields: Fields): Fields =>
  fitWith(
    fields,
    DOCUMENT_BYTES.credits,
    [
      {
        spare: (f) => spare(f.role),
        shrink: (f) => ({ ...f, role: f.role === null ? null : halved(f.role) }),
      },
    ],
    [],
  );

type CollectionFields = WithoutSystemFields<Doc<"collections">>;

/** A collection's fields kept within `DOCUMENT_BYTES.collections`: its overview first. */
export const fitCollection = <Fields extends CollectionFields>(fields: Fields): Fields =>
  fitWith(
    fields,
    DOCUMENT_BYTES.collections,
    [
      {
        spare: (f) => spare(f.overview),
        shrink: (f) => ({ ...f, overview: f.overview === null ? null : halved(f.overview) }),
      },
      { spare: (f) => spare(f.name), shrink: (f) => ({ ...f, name: halved(f.name) }) },
      { spare: (f) => spare(f.sortKey), shrink: (f) => ({ ...f, sortKey: halved(f.sortKey) }) },
      {
        spare: (f) => spare(f.poster),
        shrink: (f) => ({ ...f, poster: f.poster === null ? null : halved(f.poster) }),
      },
      {
        spare: (f) => spare(f.backdrop),
        shrink: (f) => ({ ...f, backdrop: f.backdrop === null ? null : halved(f.backdrop) }),
      },
    ],
    [],
  );
