import { Schema } from "effect";

import { command } from "./command";
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
} from "./ids";
import {
  AlbumDetail,
  AlbumPage,
  ApiKey,
  ArtistDetail,
  ArtistPage,
  Device,
  DeviceKind,
  HistoryEntry,
  Home,
  Invite,
  Job,
  Library,
  LibraryVisibility,
  Millis,
  PageArgs,
  PlaybackState,
  Playlist,
  PlaylistDetail,
  RepeatMode,
  Role,
  SearchResults,
  StreamProfile,
  StreamUrl,
  Track,
  TrackPage,
  User,
} from "./models";

const NoArgs = Schema.Struct({});

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

const Name = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(120));

const TrackIds = Schema.Array(TrackId).check(Schema.isMinLength(1), Schema.isMaxLength(2000));

const QueueIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

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
    summary: "Play the queue entry at an index",
    group: "playback",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ index: QueueIndex }),
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
      positionMs: Millis,
      playing: Schema.Boolean,
    }),
    result: Ok,
  }),

  // Queue
  "queue.add": command({
    summary: "Add songs to the queue, next or at the end",
    group: "queue",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ trackIds: TrackIds, next: Schema.optionalKey(Schema.Boolean) }),
    result: Ok,
  }),
  "queue.remove": command({
    summary: "Remove the queue entry at an index",
    group: "queue",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ index: QueueIndex }),
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

  // Devices
  "devices.list": command({
    summary: "List your devices",
    group: "devices",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
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

  // Likes and history
  "likes.list": command({
    summary: "List liked songs, newest first",
    group: "likes",
    kind: "query",
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(Track),
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
  "playlists.get": command({
    summary: "Show a playlist and its songs",
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
      description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
      trackIds: Schema.optionalKey(TrackIds),
    }),
    result: Schema.Struct({ playlistId: PlaylistId }),
  }),
  "playlists.rename": command({
    summary: "Rename a playlist",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, name: Name }),
    result: Ok,
  }),
  "playlists.delete": command({
    summary: "Delete a playlist",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId }),
    result: Ok,
  }),
  "playlists.add": command({
    summary: "Add songs to a playlist",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, trackIds: TrackIds }),
    result: Ok,
  }),
  "playlists.remove": command({
    summary: "Remove an entry from a playlist",
    group: "playlists",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ playlistId: PlaylistId, itemId: PlaylistItemId }),
    result: Ok,
  }),

  // Streaming
  "stream.url": command({
    summary: "Get a signed stream URL for a song",
    group: "playback",
    kind: "query",
    access: "user",
    job: false,
    args: Schema.Struct({ trackId: TrackId, profile: StreamProfile }),
    result: StreamUrl,
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
      path: Schema.Trimmed.check(Schema.isStartingWith("/")),
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
    summary: "Remove a library folder from the index (files stay on disk)",
    group: "libraries",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({ libraryId: LibraryId }),
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
    access: "user",
    job: false,
    args: NoArgs,
    result: Schema.Array(ApiKey),
  }),
  "keys.create": command({
    summary: "Create an API key for the CLI or an agent; the key is shown once",
    group: "keys",
    kind: "mutation",
    access: "user",
    job: false,
    args: Schema.Struct({ name: Name }),
    result: Schema.Struct({ key: Schema.String, apiKey: ApiKey }),
  }),
  "keys.revoke": command({
    summary: "Revoke an API key",
    group: "keys",
    kind: "mutation",
    access: "user",
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
    result: Schema.Array(User),
  }),
  "invites.list": command({
    summary: "List open invites",
    group: "people",
    kind: "query",
    access: "admin",
    job: false,
    args: NoArgs,
    result: Schema.Array(Invite),
  }),
  "invites.create": command({
    summary: "Invite someone; share the code or link",
    group: "people",
    kind: "mutation",
    access: "admin",
    job: false,
    args: Schema.Struct({
      email: Schema.optionalKey(Schema.Trimmed.check(Schema.isMinLength(3))),
      role: Schema.optionalKey(Role),
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
