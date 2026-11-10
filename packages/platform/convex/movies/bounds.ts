import type { Infer } from "convex/values";

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
 * maximum is stored as null (a cut id would name another title), a key or a digest is cut to its
 * maximum (its leading part still identifies), and a file whose path is over the filesystem's
 * limit is skipped, so a scan never fails on one. The fitters reserve room for each at its maximum.
 */
export const BOUNDS = {
  /** A provider's id: a TMDB, IMDb, or TVDB id, a recommendation, a trailer's video key. */
  id: 256,
  /** A key that identifies a row across scans: a title's match key, a person's key. */
  key: 512,
  /** A collection's source key, `tmdb:<id>` or `set:<name>`. */
  sourceKey: 512,
  /** A digest of credits, a collection, or a file's companions. */
  digest: 128,
  /** A genre a title is listed under. */
  genre: 64,
  /** The sort key a title genre row copies from its title. */
  genreSortKey: 128,
  /** A file's path, in UTF-8 bytes: Linux's `PATH_MAX`. */
  pathBytes: 4096,
  /** A playback's id from `movies.play.start`, which a progress row keeps: a UUID is 36. */
  playbackId: 64,
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

export const boundedKey = (key: string): string => cut(key, BOUNDS.key);

export const boundedDigest = (digest: string): string => cut(digest, BOUNDS.digest);

const encoder = new TextEncoder();

/** Whether a file's path is within the filesystem's limit. */
export const pathFits = (path: string): boolean =>
  path.length <= BOUNDS.pathBytes && encoder.encode(path).length <= BOUNDS.pathBytes;

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

export const personKeyWithin = <Fields extends { readonly personKey: string }>(
  fields: Fields,
): Fields =>
  fields.personKey.length <= BOUNDS.key
    ? fields
    : { ...fields, personKey: boundedKey(fields.personKey) };

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
    : { ...fields, sourceKey: null };

type ScannedTitle = Infer<typeof scannedTitle>;

/** A scanned title with its match key, ids, recommendations, and trailer within their bounds. */
export const boundedTitle = (title: ScannedTitle): ScannedTitle =>
  trailerWithin(recommendationsWithin(idsWithin(matchKeyWithin(title))));

type ScannedEpisode = Infer<typeof scannedEpisode>;

export const boundedEpisode = (episode: ScannedEpisode): ScannedEpisode =>
  seasonIdsWithin(optionalIdsWithin(episode));

type ScannedItem = Infer<typeof scannedItem>;

/** A scanned file with its companions' digest, its title, and its episode within their bounds. */
export const boundedItem = (item: ScannedItem): ScannedItem => ({
  file:
    item.file.sidecarDigest === undefined
      ? item.file
      : { ...item.file, sidecarDigest: boundedDigest(item.file.sidecarDigest) },
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

/** A scanned collection whose source key is null when it is over its maximum. */
export const boundedCollection = (
  collection: ScannedCollection,
): Omit<ScannedCollection, "sourceKey"> & { readonly sourceKey: string | null } =>
  sourceKeyWithin<Omit<ScannedCollection, "sourceKey"> & { readonly sourceKey: string | null }>(
    collection,
  );
