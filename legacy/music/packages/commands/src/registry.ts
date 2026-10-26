import { Schema } from "effect";

import { command } from "./command";
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
import {
  AlbumDetail,
  AlbumPage,
  ApiKey,
  ArtistDetail,
  ArtistPage,
  AssignableRole,
  Device,
  DeviceDownloads,
  DeviceKind,
  DOWNLOAD_PIN_LIMIT,
  DownloadManifest,
  DownloadTargetKind,
  DirectoryPerson,
  HistoryEntry,
  Home,
  Invite,
  JAM_ADD_LIMIT_MAX,
  Jam,
  JamEditScope,
  JamJoinPolicy,
  JamMember,
  Job,
  Library,
  LibraryMember,
  LibraryVisibility,
  LinkKind,
  Millis,
  OfflinePlay,
  OfflineResume,
  PageArgs,
  PasswordReset,
  Person,
  PlaybackPosition,
  PlaybackQueue,
  PlaybackState,
  Playlist,
  PlaylistDetail,
  PlaylistRole,
  PlaylistSharing,
  PlaylistVisibility,
  RepeatMode,
  SearchResults,
  ServerSettings,
  ShareLink,
  StreamProfile,
  StreamUrl,
  Timestamp,
  Track,
  TrackPage,
  User,
} from "./models";
import { TrackLyrics } from "./lyrics";
import { Description, Name, Text, hasControlCharacter } from "./text";

const NoArgs = Schema.Struct({});

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

/**
 * A library folder, as an absolute path on the server. Unlike a name it can't be cleaned (that
 * would name another folder), so one with a control character is refused, without repeating it.
 */
const FolderPath = Schema.String.check(
  Schema.makeFilter(
    (path: string) =>
      !hasControlCharacter(path) || "A folder path can't contain control characters",
  ),
  Schema.isTrimmed(),
  Schema.isStartingWith("/"),
);

const TrackIds = Schema.Array(TrackId).check(Schema.isMinLength(1), Schema.isMaxLength(2000));

const QueueIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A Jam's link code, or the whole link (`https://…/jam/<code>`); the server takes the code. */
const JamCode = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/**
 * Every user action, keyed by its dotted name. The web app, command menu, CLI, and agent skill all
 * read this registry, so an action added here exists everywhere.
 */
export const commands = {
  // Library
  "library.home": command({
    summary:
      "Recently added and recently played albums, recently played artists, and library totals",
    group: "library",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Home,
  }),
  "albums.list": command({
    summary: "List albums, newest first",
    group: "library",
    kind: "query",
    access: "user",
    job: false,
    args: PageArgs,
    result: AlbumPage,
  }),
  "albums.get": command({
    summary: "Show an album and its tracks",
    group: "library",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ albumId: AlbumId }),
    result: AlbumDetail,
  }),
  "artists.list": command({
    summary: "List artists by name",
    group: "library",
    kind: "query",
    access: "user",
    job: false,
    args: PageArgs,
    result: ArtistPage,
  }),
  "artists.get": command({
    summary: "Show an artist, their albums, and top songs",
    group: "library",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ artistId: ArtistId }),
    result: ArtistDetail,
  }),
  "tracks.list": command({
    summary: "List songs by title",
    group: "library",
    kind: "query",
    access: "user",
    job: false,
    args: PageArgs,
    result: TrackPage,
  }),
  search: command({
    summary: "Search songs, albums, and artists",
    group: "search",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({
      query: Schema.String.check(Schema.isMaxLength(200)),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    }),
    result: SearchResults,
  }),

  // Playback
  "playback.state": command({
    summary: "Show what is playing, where, and the queue",
    group: "playback",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: PlaybackState,
  }),
  "playback.position": command({
    summary: "Show the playing device, position, and volume, without the queue",
    group: "playback",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: PlaybackPosition,
  }),
  "playback.play": command({
    summary: "Replace the queue and start playing",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      trackIds: TrackIds,
      index: Schema.optionalKey(QueueIndex),
      deviceId: Schema.optionalKey(DeviceId),
    }),
    result: Ok,
  }),
  "playback.pause": command({
    summary: "Pause playback",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Ok,
  }),
  "playback.resume": command({
    summary: "Resume playback",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Ok,
  }),
  "playback.next": command({
    summary: "Skip to the next song",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Ok,
  }),
  "playback.previous": command({
    summary: "Go back to the previous song",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Ok,
  }),
  "playback.seek": command({
    summary: "Seek within the current song",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ positionMs: Millis }),
    result: Ok,
  }),
  "playback.jump": command({
    summary: "Play a queue entry by its item ID (queue list shows them)",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ itemId: QueueItemId }),
    result: Ok,
  }),
  "playback.shuffle": command({
    summary: "Turn shuffle on or off",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ on: Schema.Boolean }),
    result: Ok,
  }),
  "playback.repeat": command({
    summary: "Set repeat to off, all, or one",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ mode: RepeatMode }),
    result: Ok,
  }),
  "playback.volume": command({
    summary: "Set the volume from 0 to 1",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
    result: Ok,
  }),
  "playback.transfer": command({
    summary: "Move playback to another device",
    group: "devices",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ deviceId: DeviceId }),
    result: Ok,
  }),
  "playback.report": command({
    summary: "Report the active device's position (sent by players)",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      deviceId: DeviceId,
      index: QueueIndex,
      /**
       * The song playing at `index`. When the queue changed before the player saw it, the server
       * finds this song near `index` instead of trusting the index.
       */
      trackId: Schema.optionalKey(TrackId),
      /** The queue entry playing. When given, the server finds the entry by ID first. */
      itemId: Schema.optionalKey(QueueItemId),
      positionMs: Millis,
      playing: Schema.Boolean,
    }),
    result: Ok,
  }),

  // Queue
  "queue.list": command({
    summary: "Show the queue, the current song's index, shuffle, and repeat",
    group: "queue",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: PlaybackQueue,
  }),
  "queue.add": command({
    summary:
      "Add songs to the queue: --next plays them after the current song, otherwise they go after your other queued songs (before autoplay)",
    group: "queue",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ trackIds: TrackIds, next: Schema.optionalKey(Schema.Boolean) }),
    // `ok` stays for clients from before entries had IDs, which read `{ ok: true }`.
    result: Schema.Struct({ ok: Schema.Literal(true), itemIds: Schema.Array(QueueItemId) }),
  }),
  "queue.remove": command({
    summary: "Remove a queue entry by its item ID",
    group: "queue",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ itemId: QueueItemId }),
    result: Ok,
  }),
  "queue.move": command({
    summary:
      "Move a queue entry to just after another (--after-item-id), or to the top when none is given",
    group: "queue",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ itemId: QueueItemId, afterItemId: Schema.optionalKey(QueueItemId) }),
    result: Ok,
  }),
  "queue.clear": command({
    summary: "Clear everything after the current song",
    group: "queue",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Ok,
  }),
  "queue.autoplay": command({
    summary:
      "Turn autoplay on or off: when the queue runs out, play the same artist, then genre, then era",
    group: "queue",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ on: Schema.Boolean }),
    result: Ok,
  }),

  // Devices
  "devices.list": command({
    summary: "List devices seen in the last day and the one playing",
    group: "devices",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({
      /** The caller's own device, listed even when it has been silent for longer. */
      deviceId: Schema.optionalKey(DeviceId),
    }),
    result: Schema.Array(Device),
  }),
  "devices.heartbeat": command({
    summary: "Mark a device as online (sent by players)",
    group: "devices",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ deviceId: DeviceId, name: Name, kind: DeviceKind }),
    result: Ok,
  }),
  "devices.reconcile": command({
    summary:
      "Hand playback back after a device played offline: its plays, then its queue if it still plays (sent by players)",
    group: "devices",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      deviceId: DeviceId,
      plays: Schema.Array(OfflinePlay).check(Schema.isMaxLength(500)),
      resume: Schema.NullOr(OfflineResume),
    }),
    result: Schema.Struct({ adopted: Schema.Boolean }),
  }),

  // Downloads
  "downloads.list": command({
    summary: "List the albums, playlists, and songs each of your devices keeps downloaded",
    group: "downloads",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({
      /** Only this device, listed even when it keeps nothing. */
      deviceId: Schema.optionalKey(DeviceId),
    }),
    result: Schema.Array(DeviceDownloads),
  }),
  "downloads.add": command({
    summary: `Download an album, playlist, or song to one of your devices and keep it in sync (up to ${DOWNLOAD_PIN_LIMIT} per device)`,
    group: "downloads",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      deviceId: DeviceId,
      kind: DownloadTargetKind,
      id: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ pinId: DownloadPinId }),
  }),
  "downloads.remove": command({
    summary: "Stop keeping an album, playlist, or song on a device; the device deletes its files",
    group: "downloads",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      deviceId: DeviceId,
      kind: DownloadTargetKind,
      id: Schema.NonEmptyString,
    }),
    result: Ok,
  }),
  "downloads.manifest": command({
    summary: "List the songs and file revisions a download holds now (read by devices)",
    group: "downloads",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ pinId: DownloadPinId }),
    result: DownloadManifest,
  }),

  // Likes and history
  "likes.list": command({
    summary: "List up to 1,000 liked songs, newest first (likes.page reads them all)",
    group: "likes",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(Track),
  }),
  "likes.page": command({
    summary: "List liked songs, newest first, a page at a time",
    group: "likes",
    kind: "query",
    access: "user",
    job: false,
    args: PageArgs,
    result: TrackPage,
  }),
  "likes.set": command({
    summary: "Like or unlike a song",
    group: "likes",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ trackId: TrackId, liked: Schema.Boolean }),
    result: Ok,
  }),
  "history.list": command({
    summary: "List recently played songs",
    group: "likes",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    }),
    result: Schema.Array(HistoryEntry),
  }),

  // Playlists
  "playlists.list": command({
    summary: "List your playlists",
    group: "playlists",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(Playlist),
  }),
  "playlists.shared": command({
    summary: "List playlists other people shared with you by name",
    group: "playlists",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(Playlist),
  }),
  "playlists.get": command({
    summary: "Show a playlist and its songs: yours, one shared with you, or one shared by link",
    group: "playlists",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId }),
    result: PlaylistDetail,
  }),
  "playlists.create": command({
    summary: "Create a playlist",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      name: Name,
      description: Schema.optionalKey(Description),
      trackIds: Schema.optionalKey(TrackIds),
    }),
    result: Schema.Struct({ playlistId: PlaylistId }),
  }),
  "playlists.rename": command({
    summary: "Rename a playlist you own",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, name: Name }),
    result: Ok,
  }),
  "playlists.update": command({
    summary: "Change a playlist's name or description (an empty description clears it)",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      playlistId: PlaylistId,
      name: Schema.optionalKey(Name),
      description: Schema.optionalKey(Description),
    }),
    result: Ok,
  }),
  "playlists.delete": command({
    summary: "Delete a playlist you own",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId }),
    result: Ok,
  }),
  "playlists.add": command({
    summary: "Add songs to a playlist you own or collaborate on",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, trackIds: TrackIds }),
    result: Ok,
  }),
  "playlists.remove": command({
    summary: "Remove an entry from a playlist you own or collaborate on",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, itemId: PlaylistItemId }),
    result: Ok,
  }),
  "playlists.move": command({
    summary:
      "Move a playlist entry to just after another (--after-item-id), or to the top when none is given",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      playlistId: PlaylistId,
      itemId: PlaylistItemId,
      afterItemId: Schema.optionalKey(PlaylistItemId),
    }),
    result: Ok,
  }),
  "playlists.sharing": command({
    summary: "Show who a playlist you own is shared with",
    group: "playlists",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId }),
    result: PlaylistSharing,
  }),
  "playlists.visibility": command({
    summary:
      "Make a playlist you own private, or shared: anyone on this server with the link can view and play it",
    group: "playlists",
    kind: "mutation",
    access: "share",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, visibility: PlaylistVisibility }),
    result: Ok,
  }),
  "playlists.share": command({
    summary:
      "Share a playlist you own with someone as a viewer (default) or a collaborator, who adds, removes, and reorders songs",
    group: "playlists",
    kind: "mutation",
    access: "share",
    job: false,
    args: Schema.Struct({
      playlistId: PlaylistId,
      userId: UserId,
      role: Schema.optionalKey(PlaylistRole),
    }),
    result: Ok,
  }),
  "playlists.unshare": command({
    summary:
      "Stop sharing a playlist with someone, or leave one shared with you; naming no one stops sharing it at all",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, userId: Schema.optionalKey(UserId) }),
    result: Ok,
  }),

  // Links
  "links.get": command({
    summary:
      "Get a link to an album, artist, playlist, or song you can open (a song opens its album)",
    group: "library",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ kind: LinkKind, id: Schema.NonEmptyString }),
    result: ShareLink,
  }),

  // Streaming
  "stream.url": command({
    summary: "Get a signed stream URL for a song",
    group: "playback",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({
      trackId: TrackId,
      profile: StreamProfile,
      /**
       * When the client asks, in milliseconds since the epoch. Convex answers a query again from
       * its cache while the data it read is unchanged, so without a new value here a client gets
       * the URL it was given before, which may have expired. The URL is signed with the server's
       * time either way.
       */
      requestedAt: Schema.optionalKey(Timestamp),
    }),
    result: StreamUrl,
  }),

  "lyrics.get": command({
    summary: "Get a song's lyrics, timed line by line when its lyrics are synced",
    group: "playback",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ trackId: TrackId }),
    result: TrackLyrics,
  }),

  // Libraries and jobs (admin)
  "libraries.list": command({
    summary: "List library folders you can see",
    group: "libraries",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(Library),
  }),
  "libraries.create": command({
    summary: "Add a library folder and scan it",
    group: "libraries",
    kind: "mutation",
    access: "admin",
    job: true,
    args: Schema.Struct({
      name: Name,
      path: FolderPath,
      visibility: Schema.optionalKey(LibraryVisibility),
    }),
    result: Schema.Struct({ libraryId: LibraryId, jobId: JobId }),
  }),
  "libraries.scan": command({
    summary: "Rescan a library folder",
    group: "libraries",
    kind: "mutation",
    access: "admin",
    job: true,
    args: Schema.Struct({ libraryId: LibraryId }),
    result: Schema.Struct({ jobId: JobId }),
  }),
  "libraries.delete": command({
    summary:
      "Remove a library folder from the index (its owner or the server owner; files stay on disk)",
    group: "libraries",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ libraryId: LibraryId }),
    result: Ok,
  }),
  "libraries.update": command({
    summary: "Rename a library folder, or (its owner only) change who can listen to it",
    group: "libraries",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({
      libraryId: LibraryId,
      name: Schema.optionalKey(Name),
      visibility: Schema.optionalKey(LibraryVisibility),
    }),
    result: Ok,
  }),
  "libraries.people": command({
    summary: "List the people added to a library folder",
    group: "libraries",
    kind: "query",
    access: "admin",
    job: false,
    args: Schema.Struct({ libraryId: LibraryId }),
    result: Schema.Array(LibraryMember),
  }),
  "libraries.grant": command({
    summary:
      "Let someone listen to a restricted library folder you own, or a guest to a shared one",
    group: "libraries",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ libraryId: LibraryId, userId: UserId }),
    result: Ok,
  }),
  "libraries.revoke": command({
    summary: "Take someone off the access list of a library folder you own",
    group: "libraries",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ libraryId: LibraryId, userId: UserId }),
    result: Ok,
  }),
  "jobs.list": command({
    summary: "List recent jobs",
    group: "jobs",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(Job),
  }),
  "jobs.get": command({
    summary: "Show one job",
    group: "jobs",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ jobId: JobId }),
    result: Job,
  }),
  "jobs.cancel": command({
    summary: "Cancel a pending or running job",
    group: "jobs",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ jobId: JobId }),
    result: Ok,
  }),

  // Account, keys, and people
  "account.me": command({
    summary: "Show the signed-in user",
    group: "account",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: User,
  }),
  "account.rename": command({
    summary: "Change your display name",
    group: "account",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ name: Name }),
    result: Ok,
  }),
  "keys.list": command({
    summary: "List your API keys",
    group: "keys",
    kind: "query",
    access: "keys",
    job: false,
    args: NoArgs,
    result: Schema.Array(ApiKey),
  }),
  "keys.create": command({
    summary: "Create an API key for the CLI or an agent; the key is shown once",
    group: "keys",
    kind: "mutation",
    access: "keys",
    job: false,
    args: Schema.Struct({ name: Name }),
    result: Schema.Struct({ key: Schema.String, apiKey: ApiKey }),
  }),
  "keys.revoke": command({
    summary: "Revoke an API key",
    group: "keys",
    kind: "mutation",
    access: "keys",
    job: false,
    args: Schema.Struct({ apiKeyId: ApiKeyId }),
    result: Ok,
  }),
  "people.list": command({
    summary: "List people on this server",
    group: "people",
    kind: "query",
    access: "admin",
    job: false,
    args: NoArgs,
    result: Schema.Array(Person),
  }),
  "people.directory": command({
    summary: "List the people on this server you can share with: names and roles, no emails",
    group: "people",
    kind: "query",
    access: "share",
    job: false,
    args: NoArgs,
    result: Schema.Array(DirectoryPerson),
  }),
  "people.role": command({
    summary: "Change someone's role to admin, member, or guest",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ userId: UserId, role: AssignableRole }),
    result: Ok,
  }),
  "people.suspend": command({
    summary: "Suspend someone: sign them out everywhere and stop their API keys",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ userId: UserId }),
    result: Ok,
  }),
  "people.unsuspend": command({
    summary: "Let a suspended person sign in again",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ userId: UserId }),
    result: Ok,
  }),
  "people.reset": command({
    summary: "Create a one-time password reset link for someone; it lasts 24 hours",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ userId: UserId }),
    result: PasswordReset,
  }),
  "people.remove": command({
    summary:
      "Remove someone with their playlists, likes, history, devices, and keys; their libraries move to the owner",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ userId: UserId }),
    result: Ok,
  }),
  "people.transfer": command({
    summary: "Make an admin the owner of this server; you become an admin",
    group: "people",
    kind: "mutation",
    access: "owner",
    job: false,
    args: Schema.Struct({ userId: UserId }),
    result: Ok,
  }),
  "invites.list": command({
    summary: "List open and expired invites",
    group: "people",
    kind: "query",
    access: "admin",
    job: false,
    args: NoArgs,
    result: Schema.Array(Invite),
  }),
  "invites.create": command({
    summary: "Invite someone as an admin, member, or guest; share the code or link",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({
      email: Schema.optionalKey(Text.check(Schema.isMinLength(3))),
      role: Schema.optionalKey(AssignableRole),
    }),
    result: Invite,
  }),
  "invites.revoke": command({
    summary: "Revoke an invite",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ inviteId: InviteId }),
    result: Ok,
  }),

  // Server settings
  "server.settings": command({
    summary: "Show server settings, such as whether Jam links can create guest accounts",
    group: "server",
    kind: "query",
    access: "admin",
    job: false,
    args: NoArgs,
    result: ServerSettings,
  }),
  "server.update": command({
    summary:
      "Change server settings: --jam-guest-accounts lets people without an account join a Jam from its link as guests",
    group: "server",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ jamGuestAccounts: Schema.optionalKey(Schema.Boolean) }),
    result: Ok,
  }),

  // Jams
  "jam.start": command({
    summary: "Start a Jam from your playback: people who open its link share your queue and player",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Struct({ jamId: JamId, code: Schema.String }),
  }),
  "jam.get": command({
    summary:
      "Show the Jam you host, are in, or are waiting to join: host, settings, people, and its link code",
    group: "jams",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.NullOr(Jam),
  }),
  "jam.members": command({
    summary: "List the people in your Jam (the host also sees who is waiting to be let in)",
    group: "jams",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(JamMember),
  }),
  "jam.join": command({
    summary:
      "Join a Jam by its code or link; leaves any other Jam you are in. --device-id plays it on that device",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ code: JamCode, deviceId: Schema.optionalKey(DeviceId) }),
    result: Schema.Struct({ jamId: JamId, status: Schema.Literals(["joined", "pending"]) }),
  }),
  "jam.leave": command({
    summary: "Leave the Jam you are in, or dismiss one that ended; your own playback comes back",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Ok,
  }),
  "jam.listen": command({
    summary:
      "Listen along to your Jam on a device (--on --device-id <id>), or stop and use it as a remote (--no-on)",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ on: Schema.Boolean, deviceId: Schema.optionalKey(DeviceId) }),
    result: Ok,
  }),
  "jam.end": command({
    summary: "End the Jam you host; everyone gets their own player back",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Ok,
  }),
  "jam.settings": command({
    summary: "Change what people in your Jam may do (host only); flags left out stay as they are",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({
      join: Schema.optionalKey(JamJoinPolicy),
      membersCanAdd: Schema.optionalKey(Schema.Boolean),
      /** 0 removes the limit. */
      addLimit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: JAM_ADD_LIMIT_MAX })),
      ),
      membersCanControl: Schema.optionalKey(Schema.Boolean),
      membersCanEdit: Schema.optionalKey(JamEditScope),
      listenAlong: Schema.optionalKey(Schema.Boolean),
    }),
    result: Ok,
  }),
  "jam.approve": command({
    summary: "Let someone waiting into your Jam (--approve), or turn them away (--no-approve)",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ userId: UserId, approve: Schema.Boolean }),
    result: Ok,
  }),
  "jam.remove": command({
    summary: "Remove someone from your Jam; the same link won't let them back in",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ userId: UserId }),
    result: Ok,
  }),
  "jam.relink": command({
    summary: "Give your Jam a new link; the old one stops working",
    group: "jams",
    kind: "mutation",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Struct({ code: Schema.String }),
  }),
} as const;

export type Commands = typeof commands;

export type CommandName = keyof Commands;

/** Decoded arguments of a command. */
export type CommandArgs<Name extends CommandName> = Commands[Name]["args"]["Type"];

/** Arguments as they travel over the wire. */
export type CommandArgsEncoded<Name extends CommandName> = Commands[Name]["args"]["Encoded"];

/** Decoded result of a command. */
export type CommandResult<Name extends CommandName> = Commands[Name]["result"]["Type"];

/** Result as it travels over the wire. */
export type CommandResultEncoded<Name extends CommandName> = Commands[Name]["result"]["Encoded"];

export type QueryName = {
  [Name in CommandName]: Commands[Name]["kind"] extends "query" ? Name : never;
}[CommandName];

export type MutationName = Exclude<CommandName, QueryName>;

const names = Object.keys(commands);

/** Parses a string into a command name. */
export const isCommandName = (name: string): name is CommandName => names.includes(name);
