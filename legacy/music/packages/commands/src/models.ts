import { Schema } from "effect";

import {
  AlbumId,
  ApiKeyId,
  ArtistId,
  DeviceId,
  InviteId,
  JobId,
  LibraryId,
  PlaylistId,
  PlaylistItemId,
  TrackId,
  UserId,
} from "./ids";

/** Milliseconds since the Unix epoch. */
export const Timestamp = Schema.Finite;

/** A duration or offset in milliseconds. */
export const Millis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Delivery tier requested from the media service. `original` is direct play; `aac-320` and
 * `aac-128` are fast-start MP4 for `<audio>`. `fmp4-flac` and `fmp4-aac` (AAC 256 kbps) are
 * fragmented MP4 for the gapless MSE engine; their responses carry the sample counts it needs to
 * trim encoder delay (`X-Music-Priming-Samples`, `X-Music-Duration-Samples`, `X-Music-Sample-Rate`).
 */
export const StreamProfile = Schema.Literals([
  "original",
  "aac-320",
  "aac-128",
  "fmp4-flac",
  "fmp4-aac",
]);

export type StreamProfile = typeof StreamProfile.Type;

/**
 * Response headers of the `fmp4-*` stream profiles, all whole numbers. The fragmented file's
 * timeline starts with `priming` samples of encoder delay, then holds `duration` real samples at
 * `sampleRate` Hz; anything after them is encoder padding.
 *
 * `estimated` is `1` on a stream sent while it is still being transcoded: `duration` is then only
 * the source's declared length, and the stream has no `sidx` index, no `ETag`, and no byte
 * ranges. Once the response ends, a `HEAD` request for the same URL returns the exact timing.
 *
 * `start` is on a stream requested from an offset (`&start=<ms>` on a transcoded profile): the
 * song sample the stream begins at. Such a stream also carries `priming` and `sampleRate` for
 * every transcoded profile (ADTS too), and an estimated `duration` for the `fmp4-*` profiles. Its
 * fragments sit on the song's own timeline: the first `tfdt` is `start`, and song sample `s` is at
 * `s + priming`, as in the full stream. ADTS has no timestamps: its audio begins with `priming`
 * samples of encoder delay, then song sample `start`.
 */
export const StreamTimingHeader = {
  priming: "X-Music-Priming-Samples",
  duration: "X-Music-Duration-Samples",
  sampleRate: "X-Music-Sample-Rate",
  estimated: "X-Music-Duration-Estimated",
  start: "X-Music-Start-Samples",
} as const;

export const Role = Schema.Literals(["admin", "member"]);

export type Role = typeof Role.Type;

export const Track = Schema.Struct({
  id: TrackId,
  title: Schema.String,
  artist: Schema.String,
  artistId: ArtistId,
  album: Schema.String,
  albumId: AlbumId,
  trackNumber: Schema.NullOr(Count),
  discNumber: Schema.NullOr(Count),
  durationMs: Millis,
  codec: Schema.String,
  lossless: Schema.Boolean,
  bitrate: Schema.NullOr(Count),
  sampleRate: Schema.NullOr(Count),
  bitDepth: Schema.NullOr(Count),
  artUrl: Schema.NullOr(Schema.String),
  liked: Schema.Boolean,
});

export interface Track extends Schema.Schema.Type<typeof Track> {}

export const AlbumCard = Schema.Struct({
  id: AlbumId,
  title: Schema.String,
  artist: Schema.String,
  artistId: ArtistId,
  year: Schema.NullOr(Count),
  artUrl: Schema.NullOr(Schema.String),
  trackCount: Count,
});

export interface AlbumCard extends Schema.Schema.Type<typeof AlbumCard> {}

export const AlbumDetail = Schema.Struct({
  album: AlbumCard,
  durationMs: Millis,
  genre: Schema.NullOr(Schema.String),
  format: Schema.String,
  tracks: Schema.Array(Track),
});

export interface AlbumDetail extends Schema.Schema.Type<typeof AlbumDetail> {}

export const ArtistCard = Schema.Struct({
  id: ArtistId,
  name: Schema.String,
  albumCount: Count,
  artUrl: Schema.NullOr(Schema.String),
});

export interface ArtistCard extends Schema.Schema.Type<typeof ArtistCard> {}

export const ArtistDetail = Schema.Struct({
  artist: ArtistCard,
  albums: Schema.Array(AlbumCard),
  topTracks: Schema.Array(Track),
});

export interface ArtistDetail extends Schema.Schema.Type<typeof ArtistDetail> {}

/** Cursor-based page. Pass `cursor` back to read the next page until `done`. */
export const PageArgs = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});

export const AlbumPage = Schema.Struct({
  items: Schema.Array(AlbumCard),
  cursor: Schema.String,
  done: Schema.Boolean,
});

export const ArtistPage = Schema.Struct({
  items: Schema.Array(ArtistCard),
  cursor: Schema.String,
  done: Schema.Boolean,
});

export const TrackPage = Schema.Struct({
  items: Schema.Array(Track),
  cursor: Schema.String,
  done: Schema.Boolean,
});

export const LibraryStats = Schema.Struct({
  tracks: Count,
  albums: Count,
  artists: Count,
  durationMs: Millis,
});

export const Home = Schema.Struct({
  recentlyAdded: Schema.Array(AlbumCard),
  recentlyPlayed: Schema.Array(AlbumCard),
  /** Artists of the recently played albums, most recent first, with their art. */
  recentlyPlayedArtists: Schema.Array(ArtistCard),
  stats: LibraryStats,
});

export interface Home extends Schema.Schema.Type<typeof Home> {}

export const SearchResults = Schema.Struct({
  tracks: Schema.Array(Track),
  albums: Schema.Array(AlbumCard),
  artists: Schema.Array(ArtistCard),
});

export interface SearchResults extends Schema.Schema.Type<typeof SearchResults> {}

export const Playlist = Schema.Struct({
  id: PlaylistId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  trackCount: Count,
  durationMs: Millis,
  artUrls: Schema.Array(Schema.String),
  updatedAt: Timestamp,
});

export interface Playlist extends Schema.Schema.Type<typeof Playlist> {}

export const PlaylistEntry = Schema.Struct({
  itemId: PlaylistItemId,
  addedAt: Timestamp,
  track: Track,
});

export const PlaylistDetail = Schema.Struct({
  playlist: Playlist,
  items: Schema.Array(PlaylistEntry),
});

export interface PlaylistDetail extends Schema.Schema.Type<typeof PlaylistDetail> {}

export const HistoryEntry = Schema.Struct({
  playedAt: Timestamp,
  track: Track,
});

export const DeviceKind = Schema.Literals(["web", "phone", "cli"]);

export type DeviceKind = typeof DeviceKind.Type;

export const Device = Schema.Struct({
  id: DeviceId,
  name: Schema.String,
  kind: DeviceKind,
  lastSeenAt: Timestamp,
  online: Schema.Boolean,
});

export interface Device extends Schema.Schema.Type<typeof Device> {}

export const RepeatMode = Schema.Literals(["off", "all", "one"]);

export type RepeatMode = typeof RepeatMode.Type;

/**
 * The user's playback session. `positionMs` was true at `updatedAt`; while `playing`, the live
 * position is `positionMs + (now - updatedAt)`.
 */
export const PlaybackState = Schema.Struct({
  activeDevice: Schema.NullOr(Device),
  queue: Schema.Array(Track),
  index: Count,
  positionMs: Millis,
  playing: Schema.Boolean,
  updatedAt: Timestamp,
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

export interface PlaybackState extends Schema.Schema.Type<typeof PlaybackState> {}

export const JobKind = Schema.Literals(["scan"]);

export const JobStatus = Schema.Literals(["pending", "running", "done", "failed", "cancelled"]);

export type JobStatus = typeof JobStatus.Type;

export const Job = Schema.Struct({
  id: JobId,
  kind: JobKind,
  status: JobStatus,
  libraryId: Schema.NullOr(LibraryId),
  label: Schema.String,
  done: Count,
  total: Schema.NullOr(Count),
  message: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  finishedAt: Schema.NullOr(Timestamp),
});

export interface Job extends Schema.Schema.Type<typeof Job> {}

export const LibraryVisibility = Schema.Literals(["shared", "private"]);

export const Library = Schema.Struct({
  id: LibraryId,
  name: Schema.String,
  path: Schema.String,
  visibility: LibraryVisibility,
  trackCount: Count,
  lastScanAt: Schema.NullOr(Timestamp),
  scanning: Schema.Boolean,
});

export interface Library extends Schema.Schema.Type<typeof Library> {}

export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  name: Schema.String,
  prefix: Schema.String,
  createdAt: Timestamp,
  lastUsedAt: Schema.NullOr(Timestamp),
});

export interface ApiKey extends Schema.Schema.Type<typeof ApiKey> {}

export const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  role: Role,
});

export interface User extends Schema.Schema.Type<typeof User> {}

export const Invite = Schema.Struct({
  id: InviteId,
  code: Schema.String,
  email: Schema.NullOr(Schema.String),
  role: Role,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  acceptedAt: Schema.NullOr(Timestamp),
});

export interface Invite extends Schema.Schema.Type<typeof Invite> {}

export const StreamUrl = Schema.Struct({
  trackId: TrackId,
  url: Schema.String,
  profile: StreamProfile,
  expiresAt: Timestamp,
});

export interface StreamUrl extends Schema.Schema.Type<typeof StreamUrl> {}
