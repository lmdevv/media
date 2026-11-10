import type { WithoutSystemFields } from "convex/server";
import { getDocumentSize } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { moviesTables } from "./schema";
import {
  BOUNDS,
  collectionHashWithin,
  creditsHashWithin,
  cut,
  idsWithin,
  matchKeyWithin,
  personKeyWithin,
  recommendationsWithin,
  sidecarDigestWithin,
  sourceKeyWithin,
  subtitlesWithin,
  trailerWithin,
  uniqueWithin,
} from "./bounds";
import { sha256Hex } from "../core/lib/sha256";

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
  mediaFiles: 16 * 1024,
  seasons: 4 * 1024,
  /**
   * A row of a small table: a grant, a library, a group membership, a title genre, a list entry,
   * a progress row, a collection membership, or a watch mark. Its fields are ids, numbers,
   * literals, and text its writer bounds.
   */
  small: 1024,
} as const;

/**
 * Every movies table's bound, typed over the schema's tables, so a table added without one fails
 * to compile. The fixed-shape rows (list entries, collection memberships, watch marks) hold only
 * ids, numbers, booleans, and literals, so they need no fitter to stay within theirs.
 */
export const TABLE_BYTES = {
  titles: DOCUMENT_BYTES.titles,
  titleGenres: DOCUMENT_BYTES.small,
  seasons: DOCUMENT_BYTES.seasons,
  episodes: DOCUMENT_BYTES.episodes,
  people: DOCUMENT_BYTES.people,
  credits: DOCUMENT_BYTES.credits,
  mediaFiles: DOCUMENT_BYTES.mediaFiles,
  collections: DOCUMENT_BYTES.collections,
  collectionItems: DOCUMENT_BYTES.small,
  watchProgress: DOCUMENT_BYTES.small,
  myList: DOCUMENT_BYTES.small,
  watchMarks: DOCUMENT_BYTES.small,
} as const satisfies { readonly [Table in keyof typeof moviesTables]: number };

/** The shortest a fitter cuts free text to. */
export const SHORTEST = 64;

const points = (text: string): number => text.length;

/** `text` cut to half its length, never below `SHORTEST`, never inside a surrogate pair. */
const halved = (text: string): string => cut(text, Math.max(SHORTEST, Math.floor(text.length / 2)));

/** How much a string field can still give: its code points past `SHORTEST`, or none. */
const spare = (text: string | null | undefined): number =>
  text === null || text === undefined ? 0 : Math.max(0, points(text) - SHORTEST);

/** Every string of a list cut in half, never below `SHORTEST`, in one step however long the list. */
const halvedAll = (list: ReadonlyArray<string>): Array<string> =>
  list.map((text) => (points(text) > SHORTEST ? halved(text) : text));

/** The first half of a list, so a list of any length is gone in a few steps. */
const firstHalf = <Item>(list: ReadonlyArray<Item>): Array<Item> =>
  list.slice(0, Math.floor(list.length / 2));

const spareOf = (list: ReadonlyArray<string> | undefined): number =>
  Math.max(0, ...(list ?? []).map((text) => spare(text)));

/** One way to make a document smaller: how much it can still give, and the smaller document. */
interface Shrinker<Fields> {
  readonly spare: (fields: Fields) => number;
  readonly shrink: (fields: Fields) => Fields;
}

/**
 * `fields` kept within `maxBytes` as Convex measures their document: while it is larger, the
 * text shrinker with the most to give halves its text; once no text can shrink, the list shrinker
 * with the longest list drops its later half. Each step halves something, so a document of any
 * size fits in a few dozen steps. It never fails a write.
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

/** A title's identity fields within their bounds (`bounds.ts`), as the server functions keep them. */
const titleIdentity = <Fields extends TitleFields>(fields: Fields): Fields =>
  collectionHashWithin(
    creditsHashWithin(trailerWithin(recommendationsWithin(idsWithin(matchKeyWithin(fields))))),
  );

type TitleFields = Omit<WithoutSystemFields<Doc<"titles">>, "tie">;

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
  { spare: (f) => spareOf(f.genres), shrink: (f) => ({ ...f, genres: halvedAll(f.genres) }) },
  {
    spare: (f) => spareOf(f.tags),
    shrink: (f) => (f.tags === undefined ? f : { ...f, tags: halvedAll(f.tags) }),
  },
  {
    spare: (f) => spareOf(f.studios),
    shrink: (f) => (f.studios === undefined ? f : { ...f, studios: halvedAll(f.studios) }),
  },
  {
    spare: (f) => spareOf(f.countries),
    shrink: (f) => (f.countries === undefined ? f : { ...f, countries: halvedAll(f.countries) }),
  },
];

const titleLists = <Fields extends TitleFields>(): ReadonlyArray<Shrinker<Fields>> => [
  { spare: (f) => f.genres.length, shrink: (f) => ({ ...f, genres: firstHalf(f.genres) }) },
  {
    spare: (f) => f.tags?.length ?? 0,
    shrink: (f) => (f.tags === undefined ? f : { ...f, tags: firstHalf(f.tags) }),
  },
  {
    spare: (f) => f.studios?.length ?? 0,
    shrink: (f) => (f.studios === undefined ? f : { ...f, studios: firstHalf(f.studios) }),
  },
  {
    spare: (f) => f.countries?.length ?? 0,
    shrink: (f) => (f.countries === undefined ? f : { ...f, countries: firstHalf(f.countries) }),
  },
  {
    spare: (f) => f.recommendations?.length ?? 0,
    shrink: (f) =>
      f.recommendations === undefined ? f : { ...f, recommendations: firstHalf(f.recommendations) },
  },
];

/**
 * A title's fields kept within `DOCUMENT_BYTES.titles`: its longest free text halved first (an
 * overview, an admin's overview, a name), then its longest lists shortened. Its library, kind,
 * match key, ids, and numbers never change.
 */
export const fitTitle = <Fields extends TitleFields>(fields: Fields): Fields =>
  fitWith(titleIdentity(fields), DOCUMENT_BYTES.titles, titleTexts<Fields>(), titleLists<Fields>());

type EpisodeFields = WithoutSystemFields<Doc<"episodes">>;

/** An episode's fields kept within `DOCUMENT_BYTES.episodes`: its overview, then its name. */
export const fitEpisode = <Fields extends EpisodeFields>(fields: Fields): Fields =>
  fitWith(
    creditsHashWithin(idsWithin(fields)),
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
    personKeyWithin(idsWithin(fields)),
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

type CreditFields = Omit<WithoutSystemFields<Doc<"credits">>, "tie">;

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

type CollectionFields = Omit<WithoutSystemFields<Doc<"collections">>, "tie">;

/** A collection's fields kept within `DOCUMENT_BYTES.collections`: its overview first. */
export const fitCollection = <Fields extends CollectionFields>(fields: Fields): Fields =>
  fitWith(
    sourceKeyWithin(fields),
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

type GenreRowFields = WithoutSystemFields<Doc<"titleGenres">>;

/**
 * A title genre row, or fields written over one, within `DOCUMENT_BYTES.small`: its genre and its
 * copy of the title's sort key cut to their bounds. The catalog keeps no genre past its bound, so
 * only a sort key is ever cut.
 */
export const fitGenreRow = <Fields extends Partial<GenreRowFields>>(fields: Fields): Fields => {
  const genre =
    fields.genre === undefined || fields.genre.length <= BOUNDS.genre
      ? fields
      : { ...fields, genre: cut(fields.genre, BOUNDS.genre) };

  return genre.sortKey === undefined || genre.sortKey.length <= BOUNDS.genreSortKey
    ? genre
    : { ...genre, sortKey: cut(genre.sortKey, BOUNDS.genreSortKey) };
};

type SeasonFields = WithoutSystemFields<Doc<"seasons">>;

/** A season's fields kept within `DOCUMENT_BYTES.seasons`: its name, then its poster key. */
export const fitSeason = <Fields extends SeasonFields>(fields: Fields): Fields =>
  fitWith(
    idsWithin(fields),
    DOCUMENT_BYTES.seasons,
    [
      { spare: (f) => spare(f.name), shrink: (f) => ({ ...f, name: halved(f.name) }) },
      {
        spare: (f) => spare(f.poster),
        shrink: (f) => ({ ...f, poster: f.poster === null ? null : halved(f.poster) }),
      },
    ],
    [],
  );

type FileFields = WithoutSystemFields<Doc<"mediaFiles">>;

type Probe = FileFields["probe"];

/** `text` halved when it is longer than `SHORTEST`, else itself. */
const shortened = (text: string): string => (points(text) > SHORTEST ? halved(text) : text);

const shortenedOrNull = (text: string | null): string | null =>
  text === null ? null : shortened(text);

const spareAll = (texts: ReadonlyArray<string | null | undefined>): number =>
  Math.max(0, ...texts.map((text) => spare(text)));

const withProbe = <Fields extends FileFields>(fields: Fields, probe: Probe): Fields => ({
  ...fields,
  probe,
});

/** A thumbnail manifest's version within the digest bound, as other digests are. */
const trickplayWithin = <Fields extends FileFields>(fields: Fields): Fields => {
  const { trickplay } = fields;

  return trickplay?.status !== "ready" || trickplay.manifest.version.length <= BOUNDS.digest
    ? fields
    : {
        ...fields,
        trickplay: {
          ...trickplay,
          manifest: {
            ...trickplay.manifest,
            version: uniqueWithin(trickplay.manifest.version, BOUNDS.digest),
          },
        },
      };
};

const fileTexts = <Fields extends FileFields>(): ReadonlyArray<Shrinker<Fields>> => [
  {
    spare: (f) => spareAll((f.probe.chapters ?? []).map((chapter) => chapter.title)),
    shrink: (f) =>
      f.probe.chapters === undefined
        ? f
        : withProbe(f, {
            ...f.probe,
            chapters: f.probe.chapters.map((chapter) => ({
              ...chapter,
              title: shortenedOrNull(chapter.title),
            })),
          }),
  },
  {
    spare: (f) =>
      spareAll(
        f.probe.audio.flatMap((track) => [
          track.title,
          track.language,
          track.codec,
          track.profile,
          track.channelLayout,
        ]),
      ),
    shrink: (f) =>
      withProbe(f, {
        ...f.probe,
        audio: f.probe.audio.map((track) => ({
          ...track,
          title: shortenedOrNull(track.title),
          language: shortenedOrNull(track.language),
          codec: shortened(track.codec),
          profile: shortenedOrNull(track.profile),
          channelLayout: shortenedOrNull(track.channelLayout),
        })),
      }),
  },
  {
    spare: (f) =>
      spareAll(f.probe.subtitles.flatMap((track) => [track.title, track.language, track.codec])),
    shrink: (f) =>
      withProbe(f, {
        ...f.probe,
        subtitles: f.probe.subtitles.map((track) => ({
          ...track,
          title: shortenedOrNull(track.title),
          language: shortenedOrNull(track.language),
          codec: shortened(track.codec),
        })),
      }),
  },
  {
    spare: (f) =>
      spareAll(f.probe.video.flatMap((track) => [track.codec, track.profile, track.pixelFormat])),
    shrink: (f) =>
      withProbe(f, {
        ...f.probe,
        video: f.probe.video.map((track) => ({
          ...track,
          codec: shortened(track.codec),
          profile: shortenedOrNull(track.profile),
          pixelFormat: shortenedOrNull(track.pixelFormat),
        })),
      }),
  },
  {
    spare: (f) =>
      spareAll(
        f.externalSubtitles.flatMap((subtitle) => [
          subtitle.title,
          subtitle.language,
          subtitle.codec,
        ]),
      ),
    shrink: (f) => ({
      ...f,
      externalSubtitles: f.externalSubtitles.map((subtitle) => {
        const shrunk = {
          ...subtitle,
          language: shortenedOrNull(subtitle.language),
          codec: shortened(subtitle.codec),
        };

        return subtitle.title === undefined
          ? shrunk
          : { ...shrunk, title: shortened(subtitle.title) };
      }),
    }),
  },
  {
    spare: (f) => spareAll([f.probe.container, f.probe.formatName]),
    shrink: (f) => {
      const container = { ...f.probe, container: shortened(f.probe.container) };

      return withProbe(
        f,
        container.formatName === undefined
          ? container
          : { ...container, formatName: shortened(container.formatName) },
      );
    },
  },
  {
    spare: (f) => spare(f.versionName),
    shrink: (f) => ({ ...f, versionName: shortenedOrNull(f.versionName) }),
  },
];

const fileLists = <Fields extends FileFields>(): ReadonlyArray<Shrinker<Fields>> => [
  {
    spare: (f) => f.probe.chapters?.length ?? 0,
    shrink: (f) =>
      f.probe.chapters === undefined
        ? f
        : withProbe(f, { ...f.probe, chapters: firstHalf(f.probe.chapters) }),
  },
  {
    spare: (f) => f.probe.subtitles.length,
    shrink: (f) => withProbe(f, { ...f.probe, subtitles: firstHalf(f.probe.subtitles) }),
  },
  {
    spare: (f) => f.externalSubtitles.length,
    shrink: (f) => ({ ...f, externalSubtitles: firstHalf(f.externalSubtitles) }),
  },
  {
    spare: (f) => f.probe.audio.length,
    shrink: (f) => withProbe(f, { ...f.probe, audio: firstHalf(f.probe.audio) }),
  },
  {
    spare: (f) => f.probe.video.length,
    shrink: (f) => withProbe(f, { ...f.probe, video: firstHalf(f.probe.video) }),
  },
];

/**
 * A media file's fields kept within `DOCUMENT_BYTES.mediaFiles`: chapter titles, track names,
 * languages, and codec names first, then the container and version names, then its longest
 * lists (chapters, tracks, subtitle files). Its library, title, episode, path, sizes, times, and
 * subtitle file names never change; its digests stay within their bound.
 */
export const fitMediaFile = <Fields extends FileFields>(fields: Fields): Fields =>
  fitWith(
    trickplayWithin(subtitlesWithin(sidecarDigestWithin(fields))),
    DOCUMENT_BYTES.mediaFiles,
    fileTexts<Fields>(),
    fileLists<Fields>(),
  );

/**
 * A progress row's playback id within its bound: `movies.play.report` refuses a longer one, and
 * a writer that sent one anyway stores its SHA-256 instead, which stays distinct.
 */
export const fitProgress = <Fields extends { readonly playId?: string | undefined }>(
  fields: Fields,
): Fields =>
  fields.playId === undefined || fields.playId.length <= BOUNDS.playbackId
    ? fields
    : { ...fields, playId: sha256Hex(fields.playId).slice(0, BOUNDS.playbackId) };
