import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import { EpisodeId, LibraryId, MediaFileId, TitleId } from "../ids";
import { Bytes, EpochMillis, Milliseconds } from "../units";
import {
  Artwork,
  CommunityRating,
  CreditKind,
  ExternalIds,
  ExternalSubtitle,
  MatchStatus,
  Probe,
  Ratings,
  ShowStatus,
  TitleKind,
  Trailer,
} from "./catalog";

/** Most studios, countries, or recommendations a title keeps. */
export const TITLE_LIST_LIMIT = 20;

/** Most keywords a title keeps. */
export const TITLE_TAG_LIMIT = 40;

/** Most credits one title's catalog record carries. */
export const CREDIT_BATCH_LIMIT = 100;

const Bounded = <Item extends Schema.Top>(item: Item, limit: number) =>
  Schema.Array(item).check(Schema.isMaxLength(limit));

/**
 * A title as the scanner identified and matched it. `matchKey` identifies the title within its
 * library across scans, such as `tmdb:603` or `local:the matrix (1999)`.
 */
export const ScannedTitle = Schema.Struct({
  kind: TitleKind,
  matchKey: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  name: Schema.String,
  sortName: Schema.NullOr(Schema.String),
  year: Schema.NullOr(Schema.Int),
  overview: Schema.NullOr(Schema.String),
  tagline: Schema.NullOr(Schema.String),
  genres: Schema.Array(Schema.String),
  certification: Schema.NullOr(Schema.String),
  ageRating: Schema.NullOr(AgeRating),
  runtimeMs: Schema.NullOr(Milliseconds),
  artwork: Artwork,
  externalIds: ExternalIds,
  matchStatus: MatchStatus.pick(["matched", "unmatched"]),
  originalName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  releaseDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(ShowStatus)),
  originalLanguage: Schema.optionalKey(Schema.NullOr(Schema.String)),
  studios: Schema.optionalKey(Bounded(Schema.String, TITLE_LIST_LIMIT)),
  countries: Schema.optionalKey(Bounded(Schema.String, TITLE_LIST_LIMIT)),
  tags: Schema.optionalKey(Bounded(Schema.String, TITLE_TAG_LIMIT)),
  ratings: Schema.optionalKey(Ratings),
  trailer: Schema.optionalKey(Schema.NullOr(Trailer)),
  /** TMDB IDs of the provider's recommendations, best first; resolved against the library on read. */
  recommendations: Schema.optionalKey(Bounded(Schema.String, TITLE_LIST_LIMIT)),
});

/** A scanned title. */
export interface ScannedTitle extends Schema.Schema.Type<typeof ScannedTitle> {}

/** An episode as the scanner identified it, with its season's details. */
export const ScannedEpisode = Schema.Struct({
  seasonNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  episodeNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.NullOr(Schema.String),
  overview: Schema.NullOr(Schema.String),
  airDate: Schema.NullOr(Schema.String),
  runtimeMs: Schema.NullOr(Milliseconds),
  still: Schema.NullOr(Schema.String),
  seasonName: Schema.NullOr(Schema.String),
  seasonPoster: Schema.NullOr(Schema.String),
  rating: Schema.optionalKey(Schema.NullOr(CommunityRating)),
  externalIds: Schema.optionalKey(ExternalIds),
  seasonExternalIds: Schema.optionalKey(ExternalIds),
});

/** A scanned episode. */
export interface ScannedEpisode extends Schema.Schema.Type<typeof ScannedEpisode> {}

/** A file as the scanner found and probed it. `path` is absolute and inside a library root. */
export const ScannedFile = Schema.Struct({
  path: Schema.String,
  sizeBytes: Bytes,
  mtimeMs: EpochMillis,
  probe: Probe,
  externalSubtitles: Schema.Array(ExternalSubtitle),
  versionName: Schema.NullOr(Schema.String),
  /** A digest of the file's companions (NFO, artwork, subtitles), to notice their edits. */
  sidecarDigest: Schema.optionalKey(Schema.String),
});

/** A scanned file. */
export interface ScannedFile extends Schema.Schema.Type<typeof ScannedFile> {}

/** One scanned file with the title (and episode, for shows) it belongs to. */
export const ScannedItem = Schema.Struct({
  file: ScannedFile,
  title: ScannedTitle,
  episode: Schema.NullOr(ScannedEpisode),
});

/** One scanned file with its title. */
export interface ScannedItem extends Schema.Schema.Type<typeof ScannedItem> {}

/** Where each upserted file landed. */
export const UpsertedFile = Schema.Struct({
  path: Schema.String,
  fileId: MediaFileId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  /**
   * Digests of what the title's credits, the episode's credits, and the title's collection last
   * stored, so a scan sends only what changed; null where nothing was written yet.
   */
  titleCreditsHash: Schema.NullOr(Schema.String),
  episodeCreditsHash: Schema.NullOr(Schema.String),
  collectionHash: Schema.NullOr(Schema.String),
});

/** Where an upserted file landed. */
export interface UpsertedFile extends Schema.Schema.Type<typeof UpsertedFile> {}

/** A known file, for skipping unchanged files and detecting missing ones. */
export const IndexedFile = Schema.Struct({
  path: Schema.String,
  sizeBytes: Bytes,
  mtimeMs: EpochMillis,
  missing: Schema.Boolean,
  /** The companions' digest the file was last scanned with; null before one was recorded. */
  sidecarDigest: Schema.NullOr(Schema.String),
});

/** A file the scanner already knows, as it compares them. */
export interface IndexedFile extends Schema.Schema.Type<typeof IndexedFile> {}

/** Everything the media service needs to serve a file named in a playback token. */
export const ResolvedFile = Schema.Struct({
  fileId: MediaFileId,
  libraryId: LibraryId,
  path: Schema.String,
  /** The library's folders; the media service refuses paths that resolve outside them. */
  roots: Schema.Array(Schema.String),
  probe: Probe,
  externalSubtitles: Schema.Array(ExternalSubtitle),
  missing: Schema.Boolean,
});

/** A file named in a playback token. */
export interface ResolvedFile extends Schema.Schema.Type<typeof ResolvedFile> {}

/** A person as a scan or metadata job found them on a credit. */
const ScannedPerson = Schema.Struct({
  name: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  externalIds: ExternalIds,
  /** The person's photo as an artwork key. */
  profile: Schema.NullOr(Schema.String),
});

/** A person on a credit. */
interface ScannedPerson extends Schema.Schema.Type<typeof ScannedPerson> {}

/** One credit as a scan or metadata job found it. */
export const ScannedCredit = Schema.Struct({
  person: ScannedPerson,
  kind: CreditKind,
  role: Schema.NullOr(Schema.String),
  order: Schema.Int,
});

/** One scanned credit. */
export interface ScannedCredit extends Schema.Schema.Type<typeof ScannedCredit> {}

/** The collection a title belongs to, from TMDB or an NFO `<set>`. */
export const ScannedCollection = Schema.Struct({
  /** `tmdb:<id>` for TMDB collections, `set:<name>` for NFO sets. */
  sourceKey: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  name: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  overview: Schema.NullOr(Schema.String),
  poster: Schema.NullOr(Schema.String),
  backdrop: Schema.NullOr(Schema.String),
});

/** The collection a title belongs to. */
export interface ScannedCollection extends Schema.Schema.Type<typeof ScannedCollection> {}

/** A person's details from the metadata provider. */
export const ScannedPersonDetails = Schema.Struct({
  ...ScannedPerson.fields,
  biography: Schema.NullOr(Schema.String),
  birthDate: Schema.NullOr(Schema.String),
  deathDate: Schema.NullOr(Schema.String),
  birthPlace: Schema.NullOr(Schema.String),
  knownFor: Schema.NullOr(Schema.String),
});

/** A person's details. */
export interface ScannedPersonDetails extends Schema.Schema.Type<typeof ScannedPersonDetails> {}
