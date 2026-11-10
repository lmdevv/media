import type { Infer } from "convex/values";

import { sha256Hex } from "../core/lib/sha256";

import type {
  externalIds,
  scannedCollection,
  scannedCredit,
  scannedEpisode,
  scannedItem,
  scannedPersonDetails,
  scannedTitle,
  trailer,
} from "./validators";

/**
 * The longest identity fields the movies tables keep (ADR 0024). The server functions that take
 * them from the scanner, a metadata job, or a person job apply these before anything is written,
 * and the document fitters (`fit.ts`) apply them again, so no writer stores more: an id over its
 * maximum is stored as null (a cut id would name another title), a key or a digest over its
 * maximum keeps its leading part and adds a hash of the whole (`uniqueWithin`), so distinct keys
 * stay distinct and one key always maps the same way, and a file whose path or subtitle file
 * name is over the filesystem's limit is skipped, so a scan never fails on one. The fitters
 * reserve room for each at its maximum.
 */
export const BOUNDS = {
  /** A provider's id: a TMDB, IMDb, or TVDB id, a recommendation, a trailer's video key. */
  id: 256,
  /** A key that identifies a row across scans: a title's match key, a person's key. */
  key: 512,
  /** A collection's source key, `tmdb:<id>` or `set:<name>`. */
  sourceKey: 512,
  /** A digest of credits, a collection, or a file's companions, or a thumbnail version. */
  digest: 128,
  /** A genre a title is listed under. */
  genre: 64,
  /** The sort key a title genre row copies from its title. */
  genreSortKey: 128,
  /** A file's path, in UTF-8 bytes: Linux's `PATH_MAX`. */
  pathBytes: 4096,
  /** A subtitle file's name beside its video, in UTF-8 bytes: Linux's `NAME_MAX`. */
  fileNameBytes: 255,
  /** A playback's id from `movies.play.start`, which a progress row keeps: a UUID is 36. */
  playbackId: 64,
} as const;

/**
 * What one import's plan holds at most (ADR 0012): `movies/imports:start` refuses a plan past any
 * of these, so a plan row stays within its table's bound.
 */
export const IMPORT_BOUNDS = {
  /** Mapped source users. */
  users: 200,
  /** A source server's or a source user's id. */
  sourceId: 256,
  /** The source server's name. */
  serverName: 256,
  /** The source server's address. */
  sourceUrl: 2048,
  /** Path mappings, and the characters of each folder in one or in a planned library. */
  pathMappings: 50,
  folder: 1024,
  /** Planned libraries, and their folders in all. */
  libraries: 50,
  libraryRoots: 50,
  /** Libraries an import found or added, at most 16 for each of its folders. */
  libraryIds: 64,
  /** Characters of each base64url field of the sealed credentials. */
  sealed: 8192,
  /** Watch items, or title edits, one write takes; its budget decides how many it writes. */
  items: 500,
  /** Collections one write takes, and the members of each. */
  collections: 10,
  members: 1000,
} as const;

type ExternalIds = Infer<typeof externalIds>;

/** A lead surrogate at the end, which a cut must not keep without its pair. */
const DANGLING = /[\uD800-\uDBFF]$/u;

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
export const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;

  const kept = text.slice(0, max);

  return DANGLING.test(kept) ? kept.slice(0, -1) : kept;
};

const idFits = (id: string | null): boolean => id === null || id.length <= BOUNDS.id;

const idsFit = (ids: ExternalIds): boolean =>
  idFits(ids.tmdb) && idFits(ids.imdb) && idFits(ids.tvdb);

/** Each provider's id, or null where it is over its maximum. */
const boundedIds = (ids: ExternalIds): ExternalIds => ({
  tmdb: idFits(ids.tmdb) ? ids.tmdb : null,
  imdb: idFits(ids.imdb) ? ids.imdb : null,
  tvdb: idFits(ids.tvdb) ? ids.tvdb : null,
});

/** What `uniqueWithin` adds after a key's leading part: `#` and 64 hex digits of SHA-256. */
const HASHED = 1 + 64;

/**
 * `key` itself when it is at most `max` long, else its leading part, `#`, and the hex SHA-256 of
 * the whole key, `max` long at most. Two keys that differ anywhere stay different, and the same
 * key always maps to the same stored key, so a rescan finds the row it wrote.
 */
export const uniqueWithin = (key: string, max: number): string =>
  key.length <= max ? key : `${cut(key, max - HASHED)}#${sha256Hex(key)}`;

export const boundedKey = (key: string): string => uniqueWithin(key, BOUNDS.key);

export const boundedDigest = (digest: string): string => uniqueWithin(digest, BOUNDS.digest);

const encoder = new TextEncoder();

const bytesWithin = (text: string, max: number): boolean =>
  text.length <= max && encoder.encode(text).length <= max;

/** Whether a file's path is within the filesystem's limit. */
export const pathFits = (path: string): boolean => bytesWithin(path, BOUNDS.pathBytes);

/** Whether a subtitle file's name is within the filesystem's limit. */
export const fileNameFits = (name: string): boolean => bytesWithin(name, BOUNDS.fileNameBytes);

/*
 * Each of these keeps one field within its bound and answers its argument itself when the field
 * already is, so a writer can tell nothing changed.
 */

export const idsWithin = <Fields extends { readonly externalIds: ExternalIds }>(
  fields: Fields,
): Fields =>
  idsFit(fields.externalIds) ? fields : { ...fields, externalIds: boundedIds(fields.externalIds) };

const optionalIdsWithin = <Fields extends { readonly externalIds?: ExternalIds }>(
  fields: Fields,
): Fields =>
  fields.externalIds === undefined || idsFit(fields.externalIds)
    ? fields
    : { ...fields, externalIds: boundedIds(fields.externalIds) };

const seasonIdsWithin = <Fields extends { readonly seasonExternalIds?: ExternalIds }>(
  fields: Fields,
): Fields =>
  fields.seasonExternalIds === undefined || idsFit(fields.seasonExternalIds)
    ? fields
    : { ...fields, seasonExternalIds: boundedIds(fields.seasonExternalIds) };

export const matchKeyWithin = <Fields extends { readonly matchKey: string }>(
  fields: Fields,
): Fields =>
  fields.matchKey.length <= BOUNDS.key
    ? fields
    : { ...fields, matchKey: boundedKey(fields.matchKey) };

export const personKeyWithin = <
  Fields extends { readonly personKey: string; readonly nameKey: string },
>(
  fields: Fields,
): Fields =>
  fields.personKey.length <= BOUNDS.key && fields.nameKey.length <= BOUNDS.key
    ? fields
    : { ...fields, personKey: boundedKey(fields.personKey), nameKey: boundedKey(fields.nameKey) };

export const recommendationsWithin = <Fields extends { readonly recommendations?: Array<string> }>(
  fields: Fields,
): Fields =>
  fields.recommendations === undefined || fields.recommendations.every(idFits)
    ? fields
    : { ...fields, recommendations: fields.recommendations.filter(idFits) };

export const trailerWithin = <Fields extends { readonly trailer?: Infer<typeof trailer> | null }>(
  fields: Fields,
): Fields =>
  fields.trailer === undefined || fields.trailer === null || idFits(fields.trailer.key)
    ? fields
    : { ...fields, trailer: null };

export const creditsHashWithin = <Fields extends { readonly creditsHash?: string }>(
  fields: Fields,
): Fields =>
  fields.creditsHash === undefined || fields.creditsHash.length <= BOUNDS.digest
    ? fields
    : { ...fields, creditsHash: boundedDigest(fields.creditsHash) };

export const collectionHashWithin = <Fields extends { readonly collectionHash?: string }>(
  fields: Fields,
): Fields =>
  fields.collectionHash === undefined || fields.collectionHash.length <= BOUNDS.digest
    ? fields
    : { ...fields, collectionHash: boundedDigest(fields.collectionHash) };

export const sourceKeyWithin = <Fields extends { readonly sourceKey: string | null }>(
  fields: Fields,
): Fields =>
  fields.sourceKey === null || fields.sourceKey.length <= BOUNDS.sourceKey
    ? fields
    : { ...fields, sourceKey: uniqueWithin(fields.sourceKey, BOUNDS.sourceKey) };

export const sidecarDigestWithin = <Fields extends { readonly sidecarDigest: string | null }>(
  fields: Fields,
): Fields =>
  fields.sidecarDigest === null || fields.sidecarDigest.length <= BOUNDS.digest
    ? fields
    : { ...fields, sidecarDigest: boundedDigest(fields.sidecarDigest) };

/** Subtitle files whose names the filesystem could hold; no other can exist. */
export const subtitlesWithin = <
  Fields extends { readonly externalSubtitles: ReadonlyArray<{ readonly fileName: string }> },
>(
  fields: Fields,
): Fields =>
  fields.externalSubtitles.every((subtitle) => fileNameFits(subtitle.fileName))
    ? fields
    : {
        ...fields,
        externalSubtitles: fields.externalSubtitles.filter((subtitle) =>
          fileNameFits(subtitle.fileName),
        ),
      };

type ScannedTitle = Infer<typeof scannedTitle>;

/** A scanned title with its match key, ids, recommendations, and trailer within their bounds. */
export const boundedTitle = (title: ScannedTitle): ScannedTitle =>
  trailerWithin(recommendationsWithin(idsWithin(matchKeyWithin(title))));

type ScannedEpisode = Infer<typeof scannedEpisode>;

export const boundedEpisode = (episode: ScannedEpisode): ScannedEpisode =>
  seasonIdsWithin(optionalIdsWithin(episode));

type ScannedItem = Infer<typeof scannedItem>;

/**
 * A scanned file with its companions' digest, its subtitle files, its title, and its episode
 * within their bounds.
 */
export const boundedItem = (item: ScannedItem): ScannedItem => ({
  file: subtitlesWithin(
    item.file.sidecarDigest === undefined
      ? item.file
      : { ...item.file, sidecarDigest: boundedDigest(item.file.sidecarDigest) },
  ),
  title: boundedTitle(item.title),
  episode: item.episode === null ? null : boundedEpisode(item.episode),
});

type ScannedCredit = Infer<typeof scannedCredit>;

export const boundedCredit = (credit: ScannedCredit): ScannedCredit => ({
  ...credit,
  person: idsWithin(credit.person),
});

type ScannedPersonDetails = Infer<typeof scannedPersonDetails>;

export const boundedPersonDetails = (details: ScannedPersonDetails): ScannedPersonDetails =>
  idsWithin(details);

type ScannedCollection = Infer<typeof scannedCollection>;

export const boundedCollection = (collection: ScannedCollection): ScannedCollection =>
  collection.sourceKey.length <= BOUNDS.sourceKey
    ? collection
    : { ...collection, sourceKey: uniqueWithin(collection.sourceKey, BOUNDS.sourceKey) };
