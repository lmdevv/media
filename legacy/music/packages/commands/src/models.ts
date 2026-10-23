import { Schema, Struct } from "effect";

import {
  AlbumId,
  ApiKeyId,
  ArtistId,
  DeviceId,
  DownloadPinId,
  InviteId,
  JamId,
  JobId,
  LibraryId,
  PlaylistId,
  PlaylistItemId,
  QueueItemId,
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

/**
 * The stream URL query parameter that asks for the finished file (`&finished=1`): the whole
 * transcode with a length, an `ETag`, and byte ranges, or a `503` with `Retry-After` while the
 * media service prepares it in the background. Never a live stream. An original is always
 * finished. The parameter is not signed: it picks the response's shape, not what the URL reads.
 */
export const FINISHED_PARAM = "finished";

/**
 * What a person may do on the server (see `permissions.ts`). `owner` is the first account and
 * exactly one person; `guest` only hears the libraries shared with them.
 */
export const Role = Schema.Literals(["owner", "admin", "member", "guest"]);

export type Role = typeof Role.Type;

/** A role an invite or a role change can give. Ownership only moves by transfer. */
export const AssignableRole = Schema.Literals(["admin", "member", "guest"]);

export type AssignableRole = typeof AssignableRole.Type;

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
  /**
   * The cursor the following page starts at, once a live client has loaded that page. The page
   * then covers everything up to it, growing past `limit` as rows are added, so no row falls
   * between two pages on screen. Such a page always reports `done: false`; the page that starts
   * at `end` tells whether the list ends there. Its `cursor` is `end`, unless it grew past the
   * most rows a page holds: then `cursor` is where it stopped, and a page starting there belongs
   * in front of the one at `end`.
   */
  end: Schema.optionalKey(Schema.NullOr(Schema.String)),
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

/** Songs a playlist holds at most. */
export const PLAYLIST_LIMIT = 2000;

/**
 * Someone named on shared things: who owns a playlist, who added a song. `name` is their display
 * name; emails are never shown to other people.
 */
export const Contributor = Schema.Struct({ id: UserId, name: Schema.String });

export interface Contributor extends Schema.Schema.Type<typeof Contributor> {}

/**
 * Who can open a playlist besides its owner and the people it is shared with: nobody (`private`),
 * or anyone signed in to the server who has the link (`shared`), as a viewer.
 */
export const PlaylistVisibility = Schema.Literals(["private", "shared"]);

export type PlaylistVisibility = typeof PlaylistVisibility.Type;

/** A role on one playlist given to a person: `viewer` plays it, `collaborator` also edits songs. */
export const PlaylistRole = Schema.Literals(["viewer", "collaborator"]);

export type PlaylistRole = typeof PlaylistRole.Type;

/** What the viewer may do with a playlist; see `canEditPlaylistItems` in `permissions.ts`. */
export const PlaylistAccess = Schema.Literals(["owner", "collaborator", "viewer"]);

export type PlaylistAccess = typeof PlaylistAccess.Type;

export const Playlist = Schema.Struct({
  id: PlaylistId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  trackCount: Count,
  durationMs: Millis,
  artUrls: Schema.Array(Schema.String),
  updatedAt: Timestamp,
  /** Null when the owner's account is gone. */
  owner: Schema.NullOr(Contributor),
  visibility: PlaylistVisibility,
  /** Whether the owner shared it with anyone by name. */
  sharedWithPeople: Schema.Boolean,
  access: PlaylistAccess,
});

export interface Playlist extends Schema.Schema.Type<typeof Playlist> {}

/**
 * Why a playlist entry can't play: its file is gone from disk (`missing`; it comes back if the
 * file does), or it is in a library the viewer can't listen to (`no_access`). Sharing a playlist
 * never grants library access.
 */
export const UnavailableReason = Schema.Literals(["missing", "no_access"]);

export type UnavailableReason = typeof UnavailableReason.Type;

export const PlaylistEntry = Schema.Struct({
  itemId: PlaylistItemId,
  addedAt: Timestamp,
  /** The song; null when it is in a library you can't read (`reason: "no_access"`). */
  track: Schema.NullOr(Track),
  /** The song's length, which every entry shows, the withheld ones too. */
  durationMs: Millis,
  /**
   * False when the song can't play here (see `reason`). The entry stays, greyed out, so you can
   * see what the playlist holds and remove it.
   */
  available: Schema.Boolean,
  reason: Schema.NullOr(UnavailableReason),
  /** Who added the song; null when their account is gone. */
  addedBy: Schema.NullOr(Contributor),
});

export interface PlaylistEntry extends Schema.Schema.Type<typeof PlaylistEntry> {}

export const PlaylistDetail = Schema.Struct({
  playlist: Playlist,
  items: Schema.Array(PlaylistEntry),
});

export interface PlaylistDetail extends Schema.Schema.Type<typeof PlaylistDetail> {}

/** Someone a playlist is shared with by name. */
export const PlaylistShare = Schema.Struct({ person: Contributor, role: PlaylistRole });

export interface PlaylistShare extends Schema.Schema.Type<typeof PlaylistShare> {}

/** Who a playlist is shared with, as its owner sees it. */
export const PlaylistSharing = Schema.Struct({
  visibility: PlaylistVisibility,
  people: Schema.Array(PlaylistShare),
});

export interface PlaylistSharing extends Schema.Schema.Type<typeof PlaylistSharing> {}

/** Someone on the server you can share with. */
export const DirectoryPerson = Schema.Struct({ id: UserId, name: Schema.String, role: Role });

export interface DirectoryPerson extends Schema.Schema.Type<typeof DirectoryPerson> {}

/** What a share link points at. A track link opens its album with the song highlighted. */
export const LinkKind = Schema.Literals(["album", "artist", "playlist", "track"]);

export type LinkKind = typeof LinkKind.Type;

/** A link to open in the web app: `path` is relative to the server's address. */
export const ShareLink = Schema.Struct({ path: Schema.String, title: Schema.String });

export interface ShareLink extends Schema.Schema.Type<typeof ShareLink> {}

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

/** Downloads one device keeps at most. */
export const DOWNLOAD_PIN_LIMIT = 500;

/** What a download keeps on a device: a song, an album, or a playlist. */
export const DownloadTargetKind = Schema.Literals(["track", "album", "playlist"]);

export type DownloadTargetKind = typeof DownloadTargetKind.Type;

/** The song, album, or playlist a download keeps. */
export const DownloadTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("track"), id: TrackId }),
  Schema.Struct({ kind: Schema.Literal("album"), id: AlbumId }),
  Schema.Struct({ kind: Schema.Literal("playlist"), id: PlaylistId }),
]);

export type DownloadTarget = typeof DownloadTarget.Type;

const downloadPinFields = {
  id: DownloadPinId,
  deviceId: DeviceId,
  target: DownloadTarget,
  createdAt: Timestamp,
};

/**
 * One song, album, or playlist a person keeps on one device; the device keeps it in sync. It is
 * `available: false` once its target is gone or you can no longer read it: the device deletes
 * what it holds for it, and the pin stays until it is removed. Its name is withheld then, as a
 * playlist withholds a song in a library you can't read.
 */
export const DownloadPin = Schema.Union([
  Schema.Struct({
    ...downloadPinFields,
    available: Schema.Literal(true),
    title: Schema.String,
    /** The artist of a song or album; the owner of a playlist. */
    subtitle: Schema.String,
    /** A playlist's cover comes with its manifest; `downloads.list` leaves it null. */
    artUrl: Schema.NullOr(Schema.String),
    /** The cover's content hash, which stays the same while `artUrl`'s signature rotates. */
    artHash: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ ...downloadPinFields, available: Schema.Literal(false) }),
]);

export type DownloadPin = typeof DownloadPin.Type;

/** A song as a download carries it: `Track` without `liked`, so a like never changes a manifest. */
export const OfflineTrack = Track.mapFields(Struct.omit(["liked"]));

export interface OfflineTrack extends Schema.Schema.Type<typeof OfflineTrack> {}

/**
 * What a device does with one song of a download:
 *
 * - `fetchable`: fetch it when it holds no copy of this revision.
 * - `missing`: its file is gone from the server's disk. Keep a copy you hold; there is nothing to
 *   fetch. Only playlists and single songs list these; an album leaves them out.
 * - `held`: its library's folder is not claimed right now (a NAS that hasn't remounted). Keep a
 *   copy you hold, fetch nothing, and delete nothing.
 */
export const ManifestEntryState = Schema.Literals(["fetchable", "missing", "held"]);

export type ManifestEntryState = typeof ManifestEntryState.Type;

export const ManifestEntry = Schema.Struct({
  track: OfflineTrack,
  /** The file's `fileRevision`. A device holding another revision fetches it again. */
  rev: Schema.String,
  artHash: Schema.NullOr(Schema.String),
  state: ManifestEntryState,
});

export interface ManifestEntry extends Schema.Schema.Type<typeof ManifestEntry> {}

/**
 * The songs a download holds now, in album or playlist order. Songs you can't read are left out,
 * and an unavailable pin holds none.
 */
export const DownloadManifest = Schema.Struct({
  pin: DownloadPin,
  entries: Schema.Array(ManifestEntry),
});

export interface DownloadManifest extends Schema.Schema.Type<typeof DownloadManifest> {}

/** One device's downloads. `device` is null when the device has no row (never seen, or pruned). */
export const DeviceDownloads = Schema.Struct({
  deviceId: DeviceId,
  device: Schema.NullOr(Device),
  pins: Schema.Array(DownloadPin),
});

export interface DeviceDownloads extends Schema.Schema.Type<typeof DeviceDownloads> {}

export const RepeatMode = Schema.Literals(["off", "all", "one"]);

export type RepeatMode = typeof RepeatMode.Type;

/**
 * Where the user's playback is. `positionMs` was true at `updatedAt`; while `playing`, the live
 * position is `positionMs + (now - updatedAt)`. It changes with every position report.
 */
export const PlaybackPosition = Schema.Struct({
  activeDevice: Schema.NullOr(Device),
  positionMs: Millis,
  playing: Schema.Boolean,
  updatedAt: Timestamp,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /**
   * True while the viewer listens along to someone else's Jam: the queue and position are the
   * host's, and `activeDevice` is the viewer's own device that plays along. Such a device keeps
   * within a second of the host by seeking, and never reports its position or moves the queue.
   */
  following: Schema.Boolean,
});

export interface PlaybackPosition extends Schema.Schema.Type<typeof PlaybackPosition> {}

/**
 * One entry in the play queue: the song, plus the entry's own ID (stable while it is queued, so
 * commands address it by ID rather than by position), who added it, and whether autoplay did.
 */
export const QueueEntry = Schema.Struct({
  ...Track.fields,
  itemId: QueueItemId,
  /** Null for entries queued before entries recorded who added them, or whose account is gone. */
  addedBy: Schema.NullOr(Contributor),
  /** Added by autoplay when the queue ran out, not by a person. */
  autoplay: Schema.Boolean,
  /**
   * Set on an entry of a Jam's queue that people in it may not know about: a song autoplay picked
   * for the host from a library shared with the host alone. Its title, artist, album, and art are
   * empty, and its song, album, and artist IDs are stand-ins that name nothing.
   */
  withheld: Schema.optionalKey(Schema.Literal(true)),
});

export interface QueueEntry extends Schema.Schema.Type<typeof QueueEntry> {}

/** The user's queue and play order. It changes when the song or the queue changes. */
export const PlaybackQueue = Schema.Struct({
  queue: Schema.Array(QueueEntry),
  index: Count,
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
  /**
   * Whether autoplay keeps the music going when the queue runs out, with songs from libraries you
   * can read: the same artist, then the same genre, then albums from around the same year.
   */
  autoplay: Schema.Boolean,
});

export interface PlaybackQueue extends Schema.Schema.Type<typeof PlaybackQueue> {}

/** The user's playback session: the position and the queue together. */
export const PlaybackState = Schema.Struct({
  ...PlaybackPosition.fields,
  ...PlaybackQueue.fields,
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

/**
 * Who can listen to a library besides its owner: `shared` is everyone but guests (guests need to
 * be added), `restricted` is only the people added, and `private` is nobody else.
 */
export const LibraryVisibility = Schema.Literals(["shared", "restricted", "private"]);

export type LibraryVisibility = typeof LibraryVisibility.Type;

/**
 * How someone may change who listens to a library (`libraryAccessControl`): any way, only to let
 * fewer people in, or not at all.
 */
export const AccessControl = Schema.Literals(["full", "narrow", "none"]);

export type AccessControl = typeof AccessControl.Type;

export const Library = Schema.Struct({
  id: LibraryId,
  name: Schema.String,
  /** The folder on the server; null for a library you see but can't manage. */
  path: Schema.NullOr(Schema.String),
  /** Whether you can rename, rescan, or remove it (`canManageLibrary`). */
  manageable: Schema.Boolean,
  /** How you can change who listens to it (`libraryAccessControl`). */
  accessControl: AccessControl,
  visibility: LibraryVisibility,
  ownerId: UserId,
  /** Null when the owner's account is gone or has no name. */
  ownerName: Schema.NullOr(Schema.String),
  /**
   * Whether you can listen to it. Admins also see that libraries they can't hear exist; those are
   * `false`, with no `path`, and only the server's owner can manage them.
   */
  readable: Schema.Boolean,
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

/** Someone on the server, as admins see them. */
export const Person = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  role: Role,
  /** A suspended person cannot sign in, and their sessions and API keys stop working. */
  suspended: Schema.Boolean,
  createdAt: Timestamp,
  /** The latest sign-in, player heartbeat, playback change, or API key use; null if none. */
  lastActiveAt: Schema.NullOr(Timestamp),
  /** A guest account made from a Jam link (when the server allows it), not from an invite. */
  joinedViaJam: Schema.Boolean,
});

export interface Person extends Schema.Schema.Type<typeof Person> {}

/** Someone added to a library's access list. */
export const LibraryMember = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  role: Role,
});

export interface LibraryMember extends Schema.Schema.Type<typeof LibraryMember> {}

/** `open` can still be used; `expired` invites stay listed so admins can see and revoke them. */
export const InviteStatus = Schema.Literals(["open", "expired"]);

export const Invite = Schema.Struct({
  id: InviteId,
  code: Schema.String,
  email: Schema.NullOr(Schema.String),
  role: AssignableRole,
  status: InviteStatus,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  acceptedAt: Schema.NullOr(Timestamp),
});

export interface Invite extends Schema.Schema.Type<typeof Invite> {}

/**
 * A one-time password reset. The token goes in the reset link (`/reset/<token>`); it is shown
 * once, works until `expiresAt`, and only its hash is stored.
 */
export const PasswordReset = Schema.Struct({
  userId: UserId,
  token: Schema.String,
  expiresAt: Timestamp,
});

export interface PasswordReset extends Schema.Schema.Type<typeof PasswordReset> {}

export const StreamUrl = Schema.Struct({
  trackId: TrackId,
  url: Schema.String,
  profile: StreamProfile,
  expiresAt: Timestamp,
});

export interface StreamUrl extends Schema.Schema.Type<typeof StreamUrl> {}

/**
 * Who can join a Jam from its link: anyone signed in (`open`), people the host approves one by
 * one (`approval`), or nobody new (`locked`).
 */
export const JamJoinPolicy = Schema.Literals(["open", "approval", "locked"]);

export type JamJoinPolicy = typeof JamJoinPolicy.Type;

/** Which queue entries people in a Jam may reorder or remove: none, their own, or any. */
export const JamEditScope = Schema.Literals(["none", "own", "any"]);

export type JamEditScope = typeof JamEditScope.Type;

/** Most upcoming songs one person may have queued in a Jam, when the host sets a limit. */
export const JAM_ADD_LIMIT_MAX = 50;

/**
 * What people in a Jam may do; the host can always do everything. Defaults: anyone with the link
 * joins, people add up to 5 upcoming songs each, only the host controls playback, people reorder
 * or remove only their own songs, and they may listen along on their own devices.
 */
export const JamSettings = Schema.Struct({
  join: JamJoinPolicy,
  membersCanAdd: Schema.Boolean,
  /** Upcoming songs one person may have queued at once; null for no limit. */
  addLimit: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: JAM_ADD_LIMIT_MAX })),
  ),
  /** Play, pause, skip, and seek. */
  membersCanControl: Schema.Boolean,
  membersCanEdit: JamEditScope,
  /** Play the Jam on their own devices, in step with the host. */
  listenAlong: Schema.Boolean,
});

export interface JamSettings extends Schema.Schema.Type<typeof JamSettings> {}

/** Where someone stands in a Jam. */
export const JamMemberStatus = Schema.Literals(["pending", "joined", "left", "removed"]);

export type JamMemberStatus = typeof JamMemberStatus.Type;

/** Someone in a Jam, or waiting to be let in. */
export const JamMember = Schema.Struct({
  person: Contributor,
  status: JamMemberStatus,
  /** Playing the Jam on their own device. */
  listening: Schema.Boolean,
  /** When they asked to join, or joined. */
  since: Timestamp,
});

export interface JamMember extends Schema.Schema.Type<typeof JamMember> {}

/** Why a Jam ended: the host ended it, the host was offline too long, or nothing played too long. */
export const JamEndReason = Schema.Literals(["host", "host_offline", "idle"]);

export type JamEndReason = typeof JamEndReason.Type;

/** The viewer's place in a Jam. */
export const JamRole = Schema.Literals(["host", "member", "pending"]);

export type JamRole = typeof JamRole.Type;

/**
 * A Jam as the viewer sees it: the one they host, are in, are waiting to join, or that just
 * ended under them (until they leave it). Only the host sees people waiting for approval.
 */
export const Jam = Schema.Struct({
  id: JamId,
  /** The link code: `/jam/<code>`. Empty for someone still waiting to be let in. */
  code: Schema.String,
  host: Contributor,
  status: Schema.Literals(["active", "ended"]),
  endedReason: Schema.NullOr(JamEndReason),
  settings: JamSettings,
  /**
   * The host removed or turned someone away under this link, so an open Jam asks the host about
   * everyone new until they make a new link. Always false for anyone but the host.
   */
  approvalAfterRemoval: Schema.Boolean,
  role: JamRole,
  /** Whether the viewer plays the Jam on their own device. */
  listening: Schema.Boolean,
  /** People joined, and for the host also those waiting for approval. */
  members: Schema.Array(JamMember),
  createdAt: Timestamp,
});

export interface Jam extends Schema.Schema.Type<typeof Jam> {}

/** Server settings an admin changes. */
export const ServerSettings = Schema.Struct({
  /**
   * Whether someone without an account can open a Jam link and make a guest account (name and
   * password) to join it. Such guests hear nothing outside the Jam.
   */
  jamGuestAccounts: Schema.Boolean,
});

export interface ServerSettings extends Schema.Schema.Type<typeof ServerSettings> {}
