import { v } from "convex/values";
import type { Validator } from "convex/values";

/** `T | null`, the stored and wire form of a field that may be empty. */
export const nullable = <T, FieldPaths extends string>(
  validator: Validator<T, "required", FieldPaths>,
) => v.union(validator, v.null());

/** A movie or a show. */
export const titleKind = v.union(v.literal("movie"), v.literal("show"));

/** How a title was identified: by its metadata, not at all, or by an admin who scans never undo. */
export const matchStatus = v.union(
  v.literal("matched"),
  v.literal("unmatched"),
  v.literal("manual"),
);

export const externalIds = v.object({
  tmdb: nullable(v.string()),
  imdb: nullable(v.string()),
  tvdb: nullable(v.string()),
});

/** Artwork keys the server serves. */
export const artwork = v.object({
  poster: nullable(v.string()),
  backdrop: nullable(v.string()),
  logo: nullable(v.string()),
});

export const communityRating = v.object({ value: v.number(), votes: nullable(v.number()) });

export const ratings = v.object({
  tmdb: nullable(communityRating),
  imdb: nullable(communityRating),
  rottenTomatoes: nullable(v.number()),
  metacritic: nullable(v.number()),
});

export const trailer = v.object({
  site: v.literal("youtube"),
  key: v.string(),
  name: nullable(v.string()),
});

export const showStatus = v.union(
  v.literal("returning"),
  v.literal("ended"),
  v.literal("canceled"),
  v.literal("in-production"),
  v.literal("planned"),
);

export const creditKind = v.union(
  v.literal("actor"),
  v.literal("guest-star"),
  v.literal("director"),
  v.literal("writer"),
  v.literal("creator"),
  v.literal("producer"),
  v.literal("composer"),
);

const hdrFormat = v.union(
  v.literal("none"),
  v.literal("hdr10"),
  v.literal("hdr10plus"),
  v.literal("hlg"),
  v.literal("dolby_vision"),
);

const videoStream = v.object({
  index: v.number(),
  codec: v.string(),
  profile: nullable(v.string()),
  level: v.optional(v.number()),
  width: v.number(),
  height: v.number(),
  frameRate: nullable(v.number()),
  bitDepth: nullable(v.number()),
  pixelFormat: nullable(v.string()),
  hdr: hdrFormat,
  bitRate: nullable(v.number()),
});

const audioStream = v.object({
  index: v.number(),
  codec: v.string(),
  profile: nullable(v.string()),
  channels: v.number(),
  channelLayout: nullable(v.string()),
  sampleRate: v.optional(v.number()),
  language: nullable(v.string()),
  title: nullable(v.string()),
  default: v.boolean(),
  bitRate: nullable(v.number()),
  endMs: v.optional(v.number()),
});

const subtitleStream = v.object({
  index: v.number(),
  codec: v.string(),
  kind: v.union(v.literal("text"), v.literal("image")),
  language: nullable(v.string()),
  title: nullable(v.string()),
  default: v.boolean(),
  forced: v.boolean(),
  hearingImpaired: v.optional(v.boolean()),
});

const chapter = v.object({
  startMs: v.number(),
  endMs: v.number(),
  title: nullable(v.string()),
});

/** What ffprobe found in a file, as the scanner reads it. */
export const probe = v.object({
  container: v.string(),
  formatName: v.optional(v.string()),
  durationMs: v.number(),
  startMs: v.optional(v.number()),
  bitRate: nullable(v.number()),
  video: v.array(videoStream),
  audio: v.array(audioStream),
  subtitles: v.array(subtitleStream),
  chapters: v.optional(v.array(chapter)),
});

/** Where a file's scrub thumbnails are and how they are laid out. */
export const trickplayManifest = v.object({
  version: v.string(),
  intervalMs: v.number(),
  tileWidth: v.number(),
  tileHeight: v.number(),
  columns: v.number(),
  rows: v.number(),
  thumbnailCount: v.number(),
  sheetCount: v.number(),
});

/**
 * A file's scrub thumbnails as stored: queued or running (`pending`, with the core job), made
 * (`ready`), or given up on (`failed`), each for the file at `sizeBytes` and `mtimeMs`. Absent
 * means none were asked for.
 */
export const trickplayState = v.union(
  v.object({
    status: v.literal("pending"),
    jobId: v.id("jobs"),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
  }),
  v.object({
    status: v.literal("ready"),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
    manifest: trickplayManifest,
  }),
  v.object({ status: v.literal("failed"), sizeBytes: v.number(), mtimeMs: v.number() }),
);

/** A subtitle file beside a media file. */
export const externalSubtitle = v.object({
  fileName: v.string(),
  codec: v.string(),
  language: nullable(v.string()),
  title: v.optional(v.string()),
  forced: v.boolean(),
  hearingImpaired: v.optional(v.boolean()),
  default: v.optional(v.boolean()),
});

/** What an admin set on a title; presentation prefers it and scans never overwrite it. */
export const metadataOverrides = v.object({
  name: v.optional(v.string()),
  sortName: v.optional(v.string()),
  year: v.optional(v.number()),
  overview: v.optional(v.string()),
  certification: v.optional(v.string()),
  ageRating: v.optional(v.number()),
});

/** A title as the scanner or a metadata job read it. */
export const scannedTitle = v.object({
  kind: titleKind,
  /** Identifies the title within its library across scans, such as `tmdb:603`. */
  matchKey: v.string(),
  name: v.string(),
  sortName: nullable(v.string()),
  year: nullable(v.number()),
  overview: nullable(v.string()),
  tagline: nullable(v.string()),
  genres: v.array(v.string()),
  certification: nullable(v.string()),
  /** The minimum viewer age the certification asks for, or null when unrated. */
  ageRating: nullable(v.number()),
  runtimeMs: nullable(v.number()),
  artwork,
  externalIds,
  matchStatus: v.union(v.literal("matched"), v.literal("unmatched")),
  originalName: v.optional(nullable(v.string())),
  releaseDate: v.optional(nullable(v.string())),
  status: v.optional(nullable(showStatus)),
  originalLanguage: v.optional(nullable(v.string())),
  studios: v.optional(v.array(v.string())),
  countries: v.optional(v.array(v.string())),
  tags: v.optional(v.array(v.string())),
  ratings: v.optional(ratings),
  trailer: v.optional(nullable(trailer)),
  recommendations: v.optional(v.array(v.string())),
});

/** An episode as the scanner or a metadata job read it, with its season's details. */
export const scannedEpisode = v.object({
  seasonNumber: v.number(),
  episodeNumber: v.number(),
  name: nullable(v.string()),
  overview: nullable(v.string()),
  airDate: nullable(v.string()),
  runtimeMs: nullable(v.number()),
  still: nullable(v.string()),
  seasonName: nullable(v.string()),
  seasonPoster: nullable(v.string()),
  rating: v.optional(nullable(communityRating)),
  externalIds: v.optional(externalIds),
  seasonExternalIds: v.optional(externalIds),
});

/** A media file the scanner found. */
export const scannedFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  versionName: nullable(v.string()),
  /** A digest of the companions the scan read (NFO, artwork, subtitles), to notice their edits. */
  sidecarDigest: v.optional(v.string()),
});

/** One file the scanner found, with the title and episode it belongs to. */
export const scannedItem = v.object({
  file: scannedFile,
  title: scannedTitle,
  episode: nullable(scannedEpisode),
});

/** Where an upserted file landed, and the digests that let the scanner skip unchanged credits. */
export const upsertedFile = v.object({
  path: v.string(),
  fileId: v.id("mediaFiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  titleCreditsHash: nullable(v.string()),
  episodeCreditsHash: nullable(v.string()),
  collectionHash: nullable(v.string()),
});

/** What the catalog knows of a file, so a scan can skip it while it is unchanged. */
export const knownFile = v.object({
  path: v.string(),
  sizeBytes: v.number(),
  mtimeMs: v.number(),
  missing: v.boolean(),
  sidecarDigest: nullable(v.string()),
});

export const scannedPerson = v.object({
  name: v.string(),
  externalIds,
  profile: nullable(v.string()),
});

export const scannedCredit = v.object({
  person: scannedPerson,
  kind: creditKind,
  role: nullable(v.string()),
  order: v.number(),
});

export const scannedCollection = v.object({
  /** `tmdb:<id>` for a TMDB collection, `set:<name>` for an NFO set. */
  sourceKey: v.string(),
  name: v.string(),
  overview: nullable(v.string()),
  poster: nullable(v.string()),
  backdrop: nullable(v.string()),
});

export const scannedPersonDetails = v.object({
  name: v.string(),
  externalIds,
  profile: nullable(v.string()),
  biography: nullable(v.string()),
  birthDate: nullable(v.string()),
  deathDate: nullable(v.string()),
  birthPlace: nullable(v.string()),
  knownFor: nullable(v.string()),
});
