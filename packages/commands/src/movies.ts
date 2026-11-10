import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Validator } from "convex/values";

import { mutation, query } from "./command.ts";
import type { Command } from "./command.ts";

const nullable = <T, FieldPaths extends string>(validator: Validator<T, "required", FieldPaths>) =>
  v.union(validator, v.null());

const titleKind = v.union(v.literal("movie"), v.literal("show"));

const matchStatus = v.union(v.literal("matched"), v.literal("unmatched"), v.literal("manual"));

const externalIds = v.object({
  tmdb: nullable(v.string()),
  imdb: nullable(v.string()),
  tvdb: nullable(v.string()),
});

/** Artwork keys the server serves. */
const artwork = v.object({
  poster: nullable(v.string()),
  backdrop: nullable(v.string()),
  logo: nullable(v.string()),
});

const communityRating = v.object({ value: v.number(), votes: nullable(v.number()) });

const ratings = v.object({
  tmdb: nullable(communityRating),
  imdb: nullable(communityRating),
  rottenTomatoes: nullable(v.number()),
  metacritic: nullable(v.number()),
});

const trailer = v.object({
  site: v.literal("youtube"),
  key: v.string(),
  name: nullable(v.string()),
});

const showStatus = v.union(
  v.literal("returning"),
  v.literal("ended"),
  v.literal("canceled"),
  v.literal("in-production"),
  v.literal("planned"),
);

const creditKind = v.union(
  v.literal("actor"),
  v.literal("guest-star"),
  v.literal("director"),
  v.literal("writer"),
  v.literal("creator"),
  v.literal("producer"),
  v.literal("composer"),
);

const credit = v.object({
  personId: v.id("people"),
  name: v.string(),
  kind: creditKind,
  role: nullable(v.string()),
  profile: nullable(v.string()),
  order: v.number(),
});

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

const chapter = v.object({ startMs: v.number(), endMs: v.number(), title: nullable(v.string()) });

const probe = v.object({
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

const trickplayManifest = v.object({
  version: v.string(),
  intervalMs: v.number(),
  tileWidth: v.number(),
  tileHeight: v.number(),
  columns: v.number(),
  rows: v.number(),
  thumbnailCount: v.number(),
  sheetCount: v.number(),
});

const externalSubtitle = v.object({
  fileName: v.string(),
  codec: v.string(),
  language: nullable(v.string()),
  title: v.optional(v.string()),
  forced: v.boolean(),
  hearingImpaired: v.optional(v.boolean()),
  default: v.optional(v.boolean()),
});

/** A file on disk without its path: what a player needs to choose tracks and scrub. */
const mediaFile = v.object({
  id: v.id("mediaFiles"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  versionName: nullable(v.string()),
  sizeBytes: v.number(),
  probe,
  externalSubtitles: v.array(externalSubtitle),
  hdr: v.boolean(),
  trickplay: nullable(trickplayManifest),
});

/** One version of a movie or an episode to choose, `lastPlayed` when your progress names it. */
const mediaVersion = v.object({
  id: v.id("mediaFiles"),
  versionName: nullable(v.string()),
  width: nullable(v.number()),
  height: nullable(v.number()),
  hdr: hdrFormat,
  videoCodec: nullable(v.string()),
  videoProfile: nullable(v.string()),
  videoLevel: nullable(v.number()),
  videoBitDepth: nullable(v.number()),
  audioCodec: nullable(v.string()),
  audioChannels: nullable(v.number()),
  audioTracks: v.number(),
  container: v.string(),
  sizeBytes: v.number(),
  durationMs: v.number(),
  lastPlayed: v.boolean(),
});

const dynamicRange = v.union(
  v.literal("sdr"),
  v.literal("hdr10"),
  v.literal("hlg"),
  v.literal("dolby-vision"),
);

/** What a device plays directly, so starting playback can prefer a version it needs no encoder for. */
const clientCapabilities = v.object({
  containers: v.array(
    v.union(
      v.literal("mp4"),
      v.literal("mov"),
      v.literal("mkv"),
      v.literal("webm"),
      v.literal("avi"),
      v.literal("ts"),
      v.literal("other"),
    ),
  ),
  videoCodecs: v.array(
    v.object({
      codec: v.string(),
      profiles: v.optional(v.array(v.string())),
      maxLevel: v.optional(v.number()),
      maxBitDepth: v.optional(v.number()),
      dynamicRanges: v.optional(v.array(dynamicRange)),
    }),
  ),
  audioCodecs: v.array(v.object({ codec: v.string(), maxChannels: v.optional(v.number()) })),
  maxWidth: v.number(),
  maxHeight: v.number(),
  hls: v.boolean(),
  mse: v.boolean(),
});

const progress = v.object({
  positionMs: v.number(),
  durationMs: v.number(),
  watched: v.boolean(),
  updatedAt: v.number(),
});

const titleCardFields = {
  id: v.id("titles"),
  kind: titleKind,
  name: v.string(),
  year: nullable(v.number()),
  certification: nullable(v.string()),
  /** The minimum viewer age, an admin's over the scanned one; null is unrated. */
  ageRating: nullable(v.number()),
  runtimeMs: nullable(v.number()),
  genres: v.array(v.string()),
  artwork,
  /** Whether any of its files is on disk. */
  available: v.boolean(),
  addedAt: v.number(),
};

/** A movie or a show in a row or a list, with an admin's edits applied. */
const titleCard = v.object(titleCardFields);

const episodeFields = {
  id: v.id("episodes"),
  titleId: v.id("titles"),
  seasonId: v.id("seasons"),
  seasonNumber: v.number(),
  episodeNumber: v.number(),
  name: v.string(),
  overview: nullable(v.string()),
  airDate: nullable(v.string()),
  runtimeMs: nullable(v.number()),
  still: nullable(v.string()),
  rating: nullable(v.number()),
  externalIds,
  available: v.boolean(),
  progress: nullable(progress),
};

const episode = v.object(episodeFields);

const season = v.object({
  id: v.id("seasons"),
  seasonNumber: v.number(),
  name: v.string(),
  poster: nullable(v.string()),
  episodeCount: v.number(),
  externalIds,
});

const titleDetail = v.object({
  ...titleCardFields,
  libraryId: v.id("libraries"),
  sortName: v.string(),
  overview: nullable(v.string()),
  tagline: nullable(v.string()),
  externalIds,
  matchStatus,
  originalName: nullable(v.string()),
  releaseDate: nullable(v.string()),
  status: nullable(showStatus),
  originalLanguage: nullable(v.string()),
  studios: v.array(v.string()),
  countries: v.array(v.string()),
  tags: v.array(v.string()),
  ratings,
  trailer: nullable(trailer),
  collection: nullable(v.object({ id: v.id("collections"), name: v.string() })),
  cast: v.array(credit),
  crew: v.array(credit),
  seasons: v.array(season),
  /** A movie's files on disk; a show's are on its episodes. */
  files: v.array(mediaFile),
  versions: v.array(mediaVersion),
  /** A movie's progress; a show's is on its episodes. */
  progress: nullable(progress),
  /** The episode a show's Play button starts, null for a movie or a finished show. */
  nextEpisode: nullable(episode),
  inMyList: v.boolean(),
});

/** Something to resume, or the next episode of a show whose latest episode you finished. */
const continueWatchingItem = v.object({
  reason: v.union(v.literal("resume"), v.literal("next")),
  title: titleCard,
  episode: nullable(episode),
  progress: nullable(progress),
});

const historyEntry = v.object({
  title: titleCard,
  episode: nullable(episode),
  progress,
  lastPlayedAt: v.number(),
});

const collection = v.object({
  id: v.id("collections"),
  name: v.string(),
  overview: nullable(v.string()),
  artwork: v.object({ poster: nullable(v.string()), backdrop: nullable(v.string()) }),
  /** The titles of the collection you may see, in its order. */
  titles: v.array(titleCard),
});

const personCard = v.object({
  id: v.id("people"),
  name: v.string(),
  profile: nullable(v.string()),
  knownFor: nullable(v.string()),
});

const personDetail = v.object({
  id: v.id("people"),
  name: v.string(),
  profile: nullable(v.string()),
  externalIds,
  biography: nullable(v.string()),
  birthDate: nullable(v.string()),
  deathDate: nullable(v.string()),
  birthPlace: nullable(v.string()),
  knownFor: nullable(v.string()),
  /** A biography is on its way: none yet, and TMDB knows the person. */
  detailsPending: v.boolean(),
  credits: v.array(
    v.object({
      title: titleCard,
      kind: creditKind,
      role: nullable(v.string()),
      episodeCount: v.number(),
    }),
  ),
});

const titleSort = v.union(v.literal("name"), v.literal("added"), v.literal("year"));

const metadataOverrides = v.object({
  name: v.optional(v.string()),
  sortName: v.optional(v.string()),
  year: v.optional(v.number()),
  overview: v.optional(v.string()),
  certification: v.optional(v.string()),
  ageRating: v.optional(v.number()),
});

const metadataField = v.union(
  v.literal("name"),
  v.literal("sortName"),
  v.literal("year"),
  v.literal("overview"),
  v.literal("certification"),
  v.literal("ageRating"),
);

const progressEvent = v.union(
  v.literal("tick"),
  v.literal("pause"),
  v.literal("resume"),
  v.literal("seek"),
  v.literal("ended"),
);

const progressReceipt = v.object({ applied: v.boolean(), watched: v.boolean() });

const watchTarget = {
  titleId: v.id("titles"),
  /** An episode of the show; omit to mean a movie, or every episode of a show. */
  episodeId: v.optional(v.id("episodes")),
};

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

/**
 * One run of the Jellyfin or Plex importer: its server, its job, the phase it reached, and what it
 * wrote. The server's import flow connects, previews, and starts runs; these commands read them,
 * for owners and admins only, which the handlers decide through `can()`.
 */
const importRun = v.object({
  importId: v.id("imports"),
  source: v.union(v.literal("jellyfin"), v.literal("plex")),
  serverName: v.string(),
  createdAt: v.number(),
  phase: v.union(
    v.literal("watchState"),
    v.literal("collections"),
    v.literal("overrides"),
    v.literal("done"),
  ),
  /** How many source users the run maps onto users here. */
  users: v.number(),
  imported: v.object({
    watched: v.number(),
    inProgress: v.number(),
    favorites: v.number(),
    collections: v.number(),
    overrides: v.number(),
    keptLocal: v.number(),
    unmatched: v.number(),
  }),
  job: v.object({
    jobId: v.id("jobs"),
    status: jobStatus,
    done: v.number(),
    total: v.union(v.number(), v.null()),
    message: v.union(v.string(), v.null()),
    error: v.union(v.string(), v.null()),
    finishedAt: v.union(v.number(), v.null()),
  }),
});

/**
 * The movies commands, ported from old movies (D62). Everything a person keeps (progress,
 * history, their list) is theirs alone (D36); nothing is keyed by a profile.
 */
export const movies = [
  query("movies.titles.home", {
    summary:
      "Show your home rows: a featured title, continue watching, your list, and the newest movies and shows",
    scope: "movies:read",
    args: {},
    result: v.object({
      featured: nullable(titleCard),
      continueWatching: v.array(continueWatchingItem),
      myList: v.array(titleCard),
      recentlyAddedMovies: v.array(titleCard),
      recentlyAddedShows: v.array(titleCard),
    }),
  }),
  query("movies.titles.list", {
    summary:
      "List the movies and shows you may see, a library at a time, by name unless sorted otherwise",
    scope: "movies:read",
    args: {
      paginationOpts: paginationOptsValidator,
      libraryId: v.optional(v.id("libraries")),
      kind: v.optional(titleKind),
      sort: v.optional(titleSort),
      genre: v.optional(v.string()),
      yearFrom: v.optional(v.number()),
      yearTo: v.optional(v.number()),
      studio: v.optional(v.string()),
      minRating: v.optional(v.number()),
    },
    result: paginationResultValidator(titleCard),
  }),
  query("movies.titles.genres", {
    summary: "List the genres of the titles you may see, most common first",
    scope: "movies:read",
    args: { kind: v.optional(titleKind) },
    result: v.array(v.object({ name: v.string(), count: v.number() })),
  }),
  query("movies.titles.search", {
    summary: "Search the titles you may see by name",
    scope: "movies:read",
    args: { query: v.string(), limit: v.optional(v.number()) },
    result: v.array(titleCard),
  }),
  query("movies.titles.similar", {
    summary: "Show titles like this one that you may see",
    scope: "movies:read",
    args: { titleId: v.id("titles"), limit: v.optional(v.number()) },
    result: v.array(titleCard),
  }),
  query("movies.titles.get", {
    summary:
      "Show a movie or show with its seasons, versions, cast and crew, and your progress and list",
    scope: "movies:read",
    args: { titleId: v.id("titles") },
    result: titleDetail,
  }),
  query("movies.titles.versions", {
    summary: "List the versions on disk of a movie or an episode, best quality first",
    scope: "movies:read",
    args: { titleId: v.id("titles"), episodeId: v.optional(v.id("episodes")) },
    result: v.array(mediaVersion),
  }),
  query("movies.titles.episodes", {
    summary: "List a season's episodes in order with your progress and their credits",
    scope: "movies:read",
    args: {
      titleId: v.id("titles"),
      seasonNumber: v.number(),
      paginationOpts: paginationOptsValidator,
    },
    result: paginationResultValidator(v.object({ ...episodeFields, credits: v.array(credit) })),
  }),
  query("movies.titles.nextEpisode", {
    summary: "Show the episode after this one, specials last, or null after the last",
    scope: "movies:read",
    args: { episodeId: v.id("episodes") },
    result: nullable(episode),
  }),
  query("movies.people.get", {
    summary: "Show a person and the titles you may see them in, newest first",
    scope: "movies:read",
    args: { personId: v.id("people") },
    result: personDetail,
  }),
  query("movies.people.search", {
    summary: "Search the cast and crew of the titles you may see by name",
    scope: "movies:read",
    args: { query: v.string(), limit: v.optional(v.number()) },
    result: v.array(personCard),
  }),
  mutation("movies.people.requestDetails", {
    summary: "Fetch a person's biography and dates when they are missing, at most every six hours",
    scope: "movies:read",
    args: { personId: v.id("people") },
    result: v.null(),
  }),
  query("movies.collections.list", {
    summary: "List collections by name with the titles you may see in each",
    scope: "movies:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(collection),
  }),
  query("movies.collections.get", {
    summary: "Show a collection and the titles you may see in it",
    scope: "movies:read",
    args: { collectionId: v.id("collections") },
    result: collection,
  }),
  query("movies.myList.list", {
    summary: "List your list, most recently added first",
    scope: "movies:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(titleCard),
  }),
  mutation("movies.myList.add", {
    summary: "Add a title to your list",
    scope: "movies:play",
    args: { titleId: v.id("titles") },
    result: v.null(),
  }),
  mutation("movies.myList.remove", {
    summary: "Take a title off your list",
    scope: "movies:play",
    args: { titleId: v.id("titles") },
    result: v.null(),
  }),
  query("movies.history.continueWatching", {
    summary: "List what to resume and which episodes come next, most recent first",
    scope: "movies:read",
    args: {},
    result: v.array(continueWatchingItem),
  }),
  query("movies.history.list", {
    summary: "List your watch history, most recently played first",
    scope: "movies:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(historyEntry),
  }),
  mutation("movies.history.markWatched", {
    summary: "Mark a movie, an episode, or a whole show watched",
    scope: "movies:play",
    args: watchTarget,
    result: v.null(),
  }),
  mutation("movies.history.markUnwatched", {
    summary: "Mark a movie, an episode, or a whole show unwatched",
    scope: "movies:play",
    args: watchTarget,
    result: v.null(),
  }),
  mutation("movies.play.start", {
    summary:
      "Start a movie or an episode: choose its file, resume your position, and get a stream ticket for this session",
    scope: "movies:play",
    args: {
      ...watchTarget,
      /** A version from `movies.titles.versions`; omit for the one you last played, else the best. */
      fileId: v.optional(v.id("mediaFiles")),
      /** What this device plays directly, preferred after the version you last played. */
      capabilities: v.optional(clientCapabilities),
    },
    result: v.object({
      titleId: v.id("titles"),
      episodeId: nullable(v.id("episodes")),
      episode: nullable(episode),
      file: mediaFile,
      resumePositionMs: v.number(),
      /** This start's own playback id; its reports carry it with `startedAt`. */
      playbackId: v.string(),
      /** When this start happened; reports carry it, so an older start cannot drag progress back. */
      startedAt: v.number(),
      /** A personal `play` ticket for the file, naming this session; at most 6 hours. */
      ticket: v.string(),
      expiresAt: v.number(),
    }),
  }),
  mutation("movies.play.report", {
    summary: "Save your position in a file you started, marking it watched at the end",
    scope: "movies:play",
    args: {
      fileId: v.id("mediaFiles"),
      positionMs: v.number(),
      durationMs: v.optional(v.number()),
      event: progressEvent,
      /** `playbackId` from the `movies.play.start` this playback came from. */
      playbackId: v.string(),
      /** `startedAt` from the same start. */
      startedAt: v.number(),
    },
    result: progressReceipt,
  }),
  mutation("movies.play.reportOffline", {
    summary: "Save progress made while playing a download offline; newer progress elsewhere wins",
    scope: "movies:play",
    args: {
      fileId: v.id("mediaFiles"),
      positionMs: v.number(),
      durationMs: v.number(),
      /** When the device played to `positionMs`, by its clock. */
      playedAt: v.number(),
      /** The device's clock as it sends this, so the server corrects `playedAt` for its skew. */
      sentAt: v.number(),
    },
    result: progressReceipt,
  }),
  mutation("movies.metadata.match", {
    summary: "Match a title to a TMDB entry, which rescans then keep",
    scope: "movies:edit",
    args: { titleId: v.id("titles"), provider: v.literal("tmdb"), providerId: v.string() },
    result: v.object({ jobId: v.id("jobs") }),
  }),
  mutation("movies.metadata.refresh", {
    summary: "Fetch a title's details again from its current match",
    scope: "movies:edit",
    args: { titleId: v.id("titles") },
    result: v.object({ jobId: v.id("jobs") }),
  }),
  mutation("movies.metadata.edit", {
    summary: "Set or clear your edits to a title's name, sort name, year, overview, or rating",
    scope: "movies:edit",
    args: {
      titleId: v.id("titles"),
      set: metadataOverrides,
      clear: v.optional(v.array(metadataField)),
    },
    result: v.null(),
  }),
  query("movies.imports.list", {
    summary: "List Jellyfin and Plex imports, newest first, with their phase and what they wrote",
    scope: "movies:edit",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(importRun),
  }),
  query("movies.imports.get", {
    summary: "Show one Jellyfin or Plex import, its job, and what it wrote",
    scope: "movies:edit",
    args: { importId: v.id("imports") },
    result: importRun,
  }),
] as const satisfies ReadonlyArray<Command>;
