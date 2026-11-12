import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import { CollectionId, EpisodeId, LibraryId, MediaFileId, SeasonId, TitleId, UserId } from "../ids";
import { TrickplayManifest } from "../trickplay";
import { Bytes, EpochMillis, Milliseconds } from "../units";

/** What a library holds. `mixed` folders contain both movies and shows. */
export const LibraryKind = Schema.Literals(["movies", "shows", "mixed"]);

/** What a library holds. */
export type LibraryKind = typeof LibraryKind.Type;

/** `everyone` libraries are visible to every account; `restricted` ones only to granted members and admins. */
const LibraryAccess = Schema.Literals(["everyone", "restricted"]);

/** Who sees a library. */
type LibraryAccess = typeof LibraryAccess.Type;

/** An absolute folder path on the media host. */
export const LibraryRoot = Schema.String.check(Schema.isPattern(/^\//u), Schema.isMaxLength(1024));

/** A library's folders: one to twenty. */
export const LibraryRoots = Schema.Array(LibraryRoot).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20),
);

/** A library as viewers see it. Folder paths are visible only to `manage` sessions. */
export const Library = Schema.Struct({
  id: LibraryId,
  name: Schema.String,
  kind: LibraryKind,
  titleCount: Schema.Int,
  lastScanAt: Schema.NullOr(EpochMillis),
  scanning: Schema.Boolean,
});

/** A library. */
export interface Library extends Schema.Schema.Type<typeof Library> {}

/** A library with its folders and access rules, for admins. */
export const LibraryDetail = Schema.Struct({
  ...Library.fields,
  roots: Schema.Array(Schema.String),
  access: LibraryAccess,
  /** Members granted a `restricted` library. Admins always see every library. */
  grantedUserIds: Schema.Array(UserId),
  /** Scans queue scrub thumbnails for new and changed files. */
  trickplay: Schema.Boolean,
  createdAt: EpochMillis,
});

/** A library with its folders and access rules. */
export interface LibraryDetail extends Schema.Schema.Type<typeof LibraryDetail> {}

/** A movie or a show. */
export const TitleKind = Schema.Literals(["movie", "show"]);

/** A movie or a show. */
export type TitleKind = typeof TitleKind.Type;

/** How a title's metadata was matched. `manual` titles keep their match across rescans. */
export const MatchStatus = Schema.Literals(["matched", "unmatched", "manual"]);

/** How a title's metadata was matched. */
export type MatchStatus = typeof MatchStatus.Type;

/** Identifiers at metadata providers. */
export const ExternalIds = Schema.Struct({
  tmdb: Schema.NullOr(Schema.String),
  imdb: Schema.NullOr(Schema.String),
  tvdb: Schema.NullOr(Schema.String),
});

/** Identifiers at metadata providers. */
export interface ExternalIds extends Schema.Schema.Type<typeof ExternalIds> {}

/**
 * Artwork references. Each is an opaque key the media service minted; clients load it from
 * `${mediaBaseUrl}/artwork/${key}` (see `artworkUrl` in `@media/contracts/artwork`).
 */
export const Artwork = Schema.Struct({
  poster: Schema.NullOr(Schema.String),
  backdrop: Schema.NullOr(Schema.String),
  logo: Schema.NullOr(Schema.String),
});

/** Artwork references. */
export interface Artwork extends Schema.Schema.Type<typeof Artwork> {}

/** A title in a row or grid. */
export const TitleCard = Schema.Struct({
  id: TitleId,
  kind: TitleKind,
  name: Schema.String,
  year: Schema.NullOr(Schema.Int),
  certification: Schema.NullOr(Schema.String),
  ageRating: Schema.NullOr(AgeRating),
  runtimeMs: Schema.NullOr(Milliseconds),
  genres: Schema.Array(Schema.String),
  artwork: Artwork,
  /** At least one file is present on disk. */
  available: Schema.Boolean,
  addedAt: EpochMillis,
});

/** A title in a row or grid. */
export interface TitleCard extends Schema.Schema.Type<typeof TitleCard> {}

/** A community score on a 0–10 scale with the number of votes behind it, when known. */
export const CommunityRating = Schema.Struct({
  value: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  votes: Schema.NullOr(Schema.Int),
});

/** A community score with its vote count. */
export interface CommunityRating extends Schema.Schema.Type<typeof CommunityRating> {}

/**
 * Scores from rating sites. TMDB comes with TMDB metadata or an NFO; IMDb, Rotten Tomatoes, and
 * Metacritic come from an NFO or from OMDb when `OMDB_API_KEY` is set.
 */
export const Ratings = Schema.Struct({
  tmdb: Schema.NullOr(CommunityRating),
  imdb: Schema.NullOr(CommunityRating),
  /** The Rotten Tomatoes critics score, 0–100. */
  rottenTomatoes: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** The Metacritic score, 0–100. */
  metacritic: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
});

/** Scores from rating sites. */
export interface Ratings extends Schema.Schema.Type<typeof Ratings> {}

/** The shape of a YouTube video ID; Convex checks the same pattern (`YOUTUBE_KEY` there). */
export const YOUTUBE_KEY_PATTERN = /^[\w-]{6,20}$/u;

/** A YouTube video ID: what `youtube-nocookie.com/embed/<key>` plays. */
export const YouTubeKey = Schema.String.check(Schema.isPattern(YOUTUBE_KEY_PATTERN));

/** A title's trailer on YouTube, from TMDB videos or an NFO `<trailer>`. */
export const Trailer = Schema.Struct({
  site: Schema.Literal("youtube"),
  key: YouTubeKey,
  name: Schema.NullOr(Schema.String),
});

/** A title's trailer. */
export interface Trailer extends Schema.Schema.Type<typeof Trailer> {}

/** Whether a show still airs, from TMDB's status or an NFO `<status>`. */
export const ShowStatus = Schema.Literals([
  "returning",
  "ended",
  "canceled",
  "in-production",
  "planned",
]);

/** Whether a show still airs. */
export type ShowStatus = typeof ShowStatus.Type;

/** What a person did on a title or episode. */
export const CreditKind = Schema.Literals([
  "actor",
  "guest-star",
  "director",
  "writer",
  "creator",
  "producer",
  "composer",
]);

/** What a person did on a title or episode. */
export type CreditKind = typeof CreditKind.Type;

/** The collection a title belongs to, such as `Alien Collection`. */
export const CollectionRef = Schema.Struct({ id: CollectionId, name: Schema.String });

/** The collection a title belongs to. */
export interface CollectionRef extends Schema.Schema.Type<typeof CollectionRef> {}

/** High dynamic range format of a video stream. */
export const HdrFormat = Schema.Literals(["none", "hdr10", "hdr10plus", "hlg", "dolby_vision"]);

/** High dynamic range format. */
export type HdrFormat = typeof HdrFormat.Type;

/** A video stream from ffprobe. */
export const VideoStream = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  profile: Schema.NullOr(Schema.String),
  /** Codec level in ffprobe units (41 for H.264 4.1, 153 for HEVC 5.1), when known. */
  level: Schema.optionalKey(Schema.Int),
  width: Schema.Int,
  height: Schema.Int,
  frameRate: Schema.NullOr(Schema.Finite),
  bitDepth: Schema.NullOr(Schema.Int),
  pixelFormat: Schema.NullOr(Schema.String),
  hdr: HdrFormat,
  bitRate: Schema.NullOr(Schema.Int),
});

/** A video stream. */
export interface VideoStream extends Schema.Schema.Type<typeof VideoStream> {}

/** An audio stream from ffprobe. */
export const AudioStream = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  profile: Schema.NullOr(Schema.String),
  channels: Schema.Int,
  channelLayout: Schema.NullOr(Schema.String),
  sampleRate: Schema.optionalKey(Schema.Int),
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  default: Schema.Boolean,
  bitRate: Schema.NullOr(Schema.Int),
  /** Where the stream's last packet ends on the file's timeline; absent when the file does not say. */
  endMs: Schema.optionalKey(Schema.Int),
});

/** An audio stream. */
export interface AudioStream extends Schema.Schema.Type<typeof AudioStream> {}

/** `text` subtitles convert to WebVTT; `image` subtitles (PGS, VobSub) need burn-in. */
export const SubtitleKind = Schema.Literals(["text", "image"]);

/** A subtitle stream embedded in the container, from ffprobe. */
export const SubtitleStream = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  kind: SubtitleKind,
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  default: Schema.Boolean,
  forced: Schema.Boolean,
  hearingImpaired: Schema.optionalKey(Schema.Boolean),
});

/** An embedded subtitle stream. */
export interface SubtitleStream extends Schema.Schema.Type<typeof SubtitleStream> {}

/** A chapter marker from the file, such as a disc's scene list. */
export const Chapter = Schema.Struct({
  startMs: Milliseconds,
  endMs: Milliseconds,
  /** The chapter's name as tagged; null when the file names none. */
  title: Schema.NullOr(Schema.String),
});

/** A chapter marker. */
export interface Chapter extends Schema.Schema.Type<typeof Chapter> {}

/** What ffprobe reported about a file. */
export const Probe = Schema.Struct({
  /** Container family: `mp4`, `mov`, `mkv`, `webm`, `avi`, `ts`, or `other`. */
  container: Schema.String,
  /** ffprobe's `format_name`, such as `matroska,webm`. */
  formatName: Schema.optionalKey(Schema.String),
  durationMs: Milliseconds,
  /** Timestamp of the first frame in milliseconds; usually zero, sometimes slightly negative. */
  startMs: Schema.optionalKey(Schema.Finite),
  bitRate: Schema.NullOr(Schema.Int),
  video: Schema.Array(VideoStream),
  audio: Schema.Array(AudioStream),
  subtitles: Schema.Array(SubtitleStream),
  /** Chapters in start order; absent for files scanned before chapters were read. */
  chapters: Schema.optionalKey(Schema.Array(Chapter)),
});

/** What ffprobe reported about a file. */
export interface Probe extends Schema.Schema.Type<typeof Probe> {}

/** A sidecar subtitle file next to the media file, such as `Movie.en.srt`. */
export const ExternalSubtitle = Schema.Struct({
  /** Path relative to the media file's folder. */
  fileName: Schema.String,
  codec: Schema.String,
  language: Schema.NullOr(Schema.String),
  /** Name parts that were not a language or a flag, such as `Commentary`. */
  title: Schema.optionalKey(Schema.String),
  forced: Schema.Boolean,
  hearingImpaired: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(Schema.Boolean),
});

/** A sidecar subtitle file. */
export interface ExternalSubtitle extends Schema.Schema.Type<typeof ExternalSubtitle> {}

/** A playable file as viewers see it. Paths stay private to the media service and admins. */
export const MediaFile = Schema.Struct({
  id: MediaFileId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  /** A version label such as `Director's Cut` or `4K`, when a title has several files. */
  versionName: Schema.NullOr(Schema.String),
  sizeBytes: Bytes,
  probe: Probe,
  externalSubtitles: Schema.Array(ExternalSubtitle),
  /** The primary video stream is HDR. */
  hdr: Schema.Boolean,
  /** The file is no longer on disk. History that points at it stays. */
  missing: Schema.Boolean,
  /** Scrub thumbnails, once generated; null until then. */
  trickplay: Schema.NullOr(TrickplayManifest),
});

/** A playable file. */
export interface MediaFile extends Schema.Schema.Type<typeof MediaFile> {}

/**
 * One file of a movie or an episode when it has several, such as a Plex or Jellyfin
 * `{edition-…}` version, a part of a split movie, or a copy in another quality.
 */
export const MediaVersion = Schema.Struct({
  /** The file to pass to `playback.createSession` as `fileId`. */
  id: MediaFileId,
  /** The edition or part the file name gives, such as `Director's Cut` or `Part 2`. */
  versionName: Schema.NullOr(Schema.String),
  /** The primary video stream's picture size; null for a file without video. */
  width: Schema.NullOr(Schema.Int),
  height: Schema.NullOr(Schema.Int),
  /** The primary video stream's HDR format; `none` for SDR and files without video. */
  hdr: HdrFormat,
  /** ffmpeg codec name of the primary video stream, such as `hevc`. */
  videoCodec: Schema.NullOr(Schema.String),
  /** ffprobe profile of the primary video stream, such as `Main 10`. */
  videoProfile: Schema.NullOr(Schema.String),
  /** ffprobe level of the primary video stream, such as 153 for HEVC 5.1. */
  videoLevel: Schema.NullOr(Schema.Int),
  videoBitDepth: Schema.NullOr(Schema.Int),
  /** ffmpeg codec name of the default audio track, such as `eac3`. */
  audioCodec: Schema.NullOr(Schema.String),
  audioChannels: Schema.NullOr(Schema.Int),
  /** How many audio tracks the file carries. */
  audioTracks: Schema.Int,
  /** Container family: `mp4`, `mov`, `mkv`, `webm`, `avi`, `ts`, or `other`. */
  container: Schema.String,
  sizeBytes: Bytes,
  durationMs: Milliseconds,
  /** The version this profile last played of this movie or episode. */
  lastPlayed: Schema.Boolean,
});

/** One file of a movie or an episode. */
export interface MediaVersion extends Schema.Schema.Type<typeof MediaVersion> {}

/** A profile's progress through a movie or an episode. */
export const Progress = Schema.Struct({
  positionMs: Milliseconds,
  durationMs: Milliseconds,
  watched: Schema.Boolean,
  updatedAt: EpochMillis,
});

/** Progress through a movie or an episode. */
export interface Progress extends Schema.Schema.Type<typeof Progress> {}

/** An episode in a list. */
export const Episode = Schema.Struct({
  id: EpisodeId,
  titleId: TitleId,
  seasonId: SeasonId,
  seasonNumber: Schema.Int,
  episodeNumber: Schema.Int,
  name: Schema.String,
  overview: Schema.NullOr(Schema.String),
  airDate: Schema.NullOr(Schema.String),
  runtimeMs: Schema.NullOr(Milliseconds),
  still: Schema.NullOr(Schema.String),
  /** The episode's community score on a 0–10 scale. */
  rating: Schema.NullOr(Schema.Finite),
  externalIds: ExternalIds,
  available: Schema.Boolean,
  progress: Schema.NullOr(Progress),
});

/** An episode. */
export interface Episode extends Schema.Schema.Type<typeof Episode> {}

/** A row in continue watching: resume a started item, or start the next episode of a show. */
export const ContinueWatchingItem = Schema.Struct({
  reason: Schema.Literals(["resume", "next"]),
  title: TitleCard,
  episode: Schema.NullOr(Episode),
  progress: Schema.NullOr(Progress),
});

/** A row in continue watching. */
export interface ContinueWatchingItem extends Schema.Schema.Type<typeof ContinueWatchingItem> {}

/** One entry in a profile's watch history. */
export const HistoryEntry = Schema.Struct({
  title: TitleCard,
  episode: Schema.NullOr(Episode),
  progress: Progress,
  lastPlayedAt: EpochMillis,
});

/** One entry in watch history. */
export interface HistoryEntry extends Schema.Schema.Type<typeof HistoryEntry> {}

/** Metadata fields an admin can override by hand. Scans never overwrite an override. */
export const MetadataOverrides = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  sortName: Schema.optionalKey(Schema.String),
  year: Schema.optionalKey(Schema.Int),
  overview: Schema.optionalKey(Schema.String),
  certification: Schema.optionalKey(Schema.String),
  ageRating: Schema.optionalKey(AgeRating),
});

/** Metadata fields an admin overrides. */
export interface MetadataOverrides extends Schema.Schema.Type<typeof MetadataOverrides> {}

/** A possible metadata match offered when fixing a title's match. */
export const MetadataCandidate = Schema.Struct({
  provider: Schema.Literal("tmdb"),
  providerId: Schema.String,
  kind: TitleKind,
  name: Schema.String,
  year: Schema.NullOr(Schema.Int),
  overview: Schema.NullOr(Schema.String),
  /** A poster URL at the provider, for the match picker. */
  posterUrl: Schema.NullOr(Schema.String),
});

/** A possible metadata match. */
export interface MetadataCandidate extends Schema.Schema.Type<typeof MetadataCandidate> {}

/** A folder on the media host that a library could use. */
export const ServerFolder = Schema.Struct({
  name: Schema.String,
  path: LibraryRoot,
});

/** A folder on the media host. */
export interface ServerFolder extends Schema.Schema.Type<typeof ServerFolder> {}

/**
 * One level of the media host's folders inside its approved library roots (`LIBRARY_ROOTS`), for
 * choosing a library's folder. `path` null lists the approved roots themselves.
 */
export const ServerFolders = Schema.Struct({
  /** The folder listed; null for the list of approved roots. */
  path: Schema.NullOr(LibraryRoot),
  /** The folder one level up; null at an approved root, whose parent is the list of roots. */
  parent: Schema.NullOr(LibraryRoot),
  /** The folders inside it by name, hidden ones and links leading out of the roots left out. */
  folders: Schema.Array(ServerFolder),
  /** Whether it holds more than one listing shows; type the path of a folder past them. */
  truncated: Schema.Boolean,
});

/** One level of the media host's folders. */
export interface ServerFolders extends Schema.Schema.Type<typeof ServerFolders> {}
