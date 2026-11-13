import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Validator } from "convex/values";

import { mutation, query } from "./command.ts";
import type { Command } from "./command.ts";

const nullable = <T, FieldPaths extends string>(validator: Validator<T, "required", FieldPaths>) =>
  v.union(validator, v.null());

/**
 * Artwork as a path on the media server with its shareable `image` ticket, which a client prefixes
 * with the media server's address; null when there is none.
 */
const artUrl = nullable(v.string());

const track = v.object({
  id: v.id("tracks"),
  title: v.string(),
  artist: v.string(),
  artistId: v.id("artists"),
  album: v.string(),
  albumId: v.id("albums"),
  trackNumber: nullable(v.number()),
  discNumber: nullable(v.number()),
  durationMs: v.number(),
  codec: v.string(),
  lossless: v.boolean(),
  bitrate: nullable(v.number()),
  sampleRate: nullable(v.number()),
  bitDepth: nullable(v.number()),
  artUrl,
  /** Whether you like it. */
  liked: v.boolean(),
});

const albumCard = v.object({
  id: v.id("albums"),
  title: v.string(),
  artist: v.string(),
  artistId: v.id("artists"),
  year: nullable(v.number()),
  artUrl,
  trackCount: v.number(),
});

const artistCard = v.object({
  id: v.id("artists"),
  name: v.string(),
  albumCount: v.number(),
  artUrl,
});

/** Someone named on shared things: a playlist's owner, or who added a song. */
const contributor = v.object({ id: v.id("users"), name: v.string() });

/** Nobody besides the people it is shared with (`private`), or everyone on the server (`shared`). */
const playlistVisibility = v.union(v.literal("private"), v.literal("shared"));

/** A person a playlist is shared with plays it (`viewer`) or also changes its songs. */
const playlistRole = v.union(v.literal("viewer"), v.literal("collaborator"));

const playlist = v.object({
  id: v.id("playlists"),
  name: v.string(),
  description: nullable(v.string()),
  trackCount: v.number(),
  durationMs: v.number(),
  /** Up to four covers of songs you may play, for its mosaic. */
  artUrls: v.array(v.string()),
  updatedAt: v.number(),
  /** Null when the owner's account is gone. */
  owner: nullable(contributor),
  visibility: playlistVisibility,
  /** Whether it is shared with anyone by name. */
  sharedWithPeople: v.boolean(),
  /** What you may do with it. */
  access: v.union(v.literal("owner"), v.literal("collaborator"), v.literal("viewer")),
});

const playlistEntry = v.object({
  itemId: v.id("playlistItems"),
  addedAt: v.number(),
  /** The song; null when you may not play it (`no_access`). */
  track: nullable(track),
  durationMs: v.number(),
  /** False when the song cannot play here: its file is `missing`, or you have `no_access`. */
  available: v.boolean(),
  reason: nullable(v.union(v.literal("missing"), v.literal("no_access"))),
  /** Null when their account is gone. */
  addedBy: nullable(contributor),
});

const repeatMode = v.union(v.literal("off"), v.literal("all"), v.literal("one"));

const lyricTime = { startMs: v.number(), endMs: nullable(v.number()) };

const lyricLine = v.object({
  text: v.string(),
  ...lyricTime,
  /** Set only when the source timed each word. */
  words: nullable(v.array(v.object({ text: v.string(), ...lyricTime }))),
  /** The singer, when the source marks one. */
  voice: nullable(v.string()),
});

/** One version of a song's lyrics: from a file beside it or a tag inside it. */
const lyricSet = v.object({
  kind: v.union(v.literal("main"), v.literal("translation"), v.literal("pronunciation")),
  /** A BCP 47 tag, such as `en` or `pt-BR`, or null for none. */
  lang: nullable(v.string()),
  origin: v.union(
    v.object({
      type: v.literal("sidecar"),
      fileName: v.string(),
      format: v.union(
        v.literal("lrc"),
        v.literal("elrc"),
        v.literal("ttml"),
        v.literal("vtt"),
        v.literal("srt"),
        v.literal("txt"),
        v.literal("lyricsfile"),
      ),
    }),
    v.object({
      type: v.literal("embedded"),
      tag: v.union(
        v.literal("id3:USLT"),
        v.literal("id3:SYLT"),
        v.literal("vorbis:LYRICS"),
        v.literal("vorbis:UNSYNCEDLYRICS"),
        v.literal("vorbis:SYNCEDLYRICS"),
        v.literal("mp4:lyr"),
        v.literal("other"),
      ),
    }),
  ),
  body: v.union(
    v.object({ type: v.literal("synced"), lines: v.array(lyricLine) }),
    v.object({ type: v.literal("plain"), text: v.string() }),
  ),
});

/** The songs a command takes, in order: at most 2,000. */
const trackIds = v.array(v.id("tracks"));

/**
 * The music commands, ported from old music's command registry (D23, D62). What each person
 * keeps (playlists, likes, plays, the queue) is theirs alone; a playlist is shared through the
 * core's grants. Jams and moving playback between devices come back with group sessions and
 * Connect.
 */
export const music = [
  query("music.library.home", {
    summary:
      "Show your music home: recently added and recently played albums, recently played artists, and library totals",
    scope: "music:read",
    args: {},
    result: v.object({
      recentlyAdded: v.array(albumCard),
      recentlyPlayed: v.array(albumCard),
      recentlyPlayedArtists: v.array(artistCard),
      stats: v.object({
        tracks: v.number(),
        albums: v.number(),
        artists: v.number(),
        durationMs: v.number(),
      }),
    }),
  }),
  query("music.library.search", {
    summary: "Search the songs, albums, and artists you may play",
    scope: "music:read",
    args: {
      query: v.string(),
      /** Results of each kind, 1 to 50; 20 when omitted. */
      limit: v.optional(v.number()),
    },
    result: v.object({
      tracks: v.array(track),
      albums: v.array(albumCard),
      artists: v.array(artistCard),
    }),
  }),
  query("music.albums.list", {
    summary: "List the albums you may play, newest first",
    scope: "music:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(albumCard),
  }),
  query("music.albums.get", {
    summary: "Show an album: its artist, year, length, genre, and format",
    scope: "music:read",
    args: { albumId: v.id("albums") },
    result: v.object({
      album: albumCard,
      durationMs: v.number(),
      genre: nullable(v.string()),
      format: v.string(),
    }),
  }),
  query("music.albums.tracks", {
    summary: "List an album's songs on disk in disc and track order",
    scope: "music:read",
    args: { albumId: v.id("albums"), paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(track),
  }),
  query("music.artists.list", {
    summary: "List the artists you may play, by name",
    scope: "music:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(artistCard),
  }),
  query("music.artists.get", {
    summary: "Show an artist and their top songs",
    scope: "music:read",
    args: { artistId: v.id("artists") },
    result: v.object({ artist: artistCard, topTracks: v.array(track) }),
  }),
  query("music.artists.albums", {
    summary: "List an artist's albums, newest year first",
    scope: "music:read",
    args: { artistId: v.id("artists"), paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(albumCard),
  }),
  query("music.tracks.list", {
    summary: "List the songs you may play, by title",
    scope: "music:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(track),
  }),
  query("music.playlists.list", {
    summary: "List your playlists, most recently changed first",
    scope: "music:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(playlist),
  }),
  query("music.playlists.shared", {
    summary: "List playlists other people shared with you by name",
    scope: "music:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(playlist),
  }),
  query("music.playlists.get", {
    summary: "Show a playlist: yours, one shared with you, or one shared with everyone",
    scope: "music:read",
    args: { playlistId: v.id("playlists") },
    result: playlist,
  }),
  query("music.playlists.items", {
    summary: "List a playlist's songs in order, with the ones you cannot play greyed out",
    scope: "music:read",
    args: { playlistId: v.id("playlists"), paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(playlistEntry),
  }),
  mutation("music.playlists.create", {
    summary: "Create a playlist, with songs to start it",
    scope: "music:edit",
    args: {
      /** 1 to 120 printable characters. */
      name: v.string(),
      /** Up to 500 characters; empty for none. */
      description: v.optional(v.string()),
      trackIds: v.optional(trackIds),
    },
    result: v.object({ playlistId: v.id("playlists") }),
  }),
  mutation("music.playlists.update", {
    summary: "Rename a playlist you own or change its description; an empty description clears it",
    scope: "music:edit",
    args: {
      playlistId: v.id("playlists"),
      name: v.optional(v.string()),
      description: v.optional(v.string()),
    },
    result: v.null(),
  }),
  mutation("music.playlists.remove", {
    summary: "Delete a playlist you own",
    scope: "music:edit",
    args: { playlistId: v.id("playlists") },
    result: v.null(),
  }),
  mutation("music.playlists.addTracks", {
    summary: "Add songs to the end of a playlist you own or collaborate on (2,000 songs at most)",
    scope: "music:edit",
    args: { playlistId: v.id("playlists"), trackIds },
    result: v.object({ itemIds: v.array(v.id("playlistItems")) }),
  }),
  mutation("music.playlists.removeItem", {
    summary: "Remove an entry from a playlist you own or collaborate on",
    scope: "music:edit",
    args: { playlistId: v.id("playlists"), itemId: v.id("playlistItems") },
    result: v.null(),
  }),
  mutation("music.playlists.moveItem", {
    summary:
      "Move a playlist entry to just after another (--after-item-id), or to the top when none is given",
    scope: "music:edit",
    args: {
      playlistId: v.id("playlists"),
      itemId: v.id("playlistItems"),
      afterItemId: v.optional(v.id("playlistItems")),
    },
    result: v.null(),
  }),
  query("music.playlists.sharing", {
    summary: "Show who a playlist you own is shared with",
    scope: "music:edit",
    args: { playlistId: v.id("playlists") },
    result: v.object({
      visibility: playlistVisibility,
      people: v.array(v.object({ person: contributor, role: playlistRole })),
    }),
  }),
  mutation("music.playlists.share", {
    summary:
      "Share a playlist you own with someone as a viewer (default) or a collaborator, who adds, removes, and reorders songs",
    scope: "music:edit",
    refusesKeys: true,
    args: {
      playlistId: v.id("playlists"),
      userId: v.id("users"),
      role: v.optional(playlistRole),
    },
    result: v.null(),
  }),
  mutation("music.playlists.unshare", {
    summary:
      "Stop sharing a playlist with someone, or leave one shared with you; naming no one stops sharing it at all",
    scope: "music:edit",
    args: { playlistId: v.id("playlists"), userId: v.optional(v.id("users")) },
    result: v.null(),
  }),
  mutation("music.playlists.visibility", {
    summary:
      "Make a playlist you own private, or shared: everyone on this server can open and play it",
    scope: "music:edit",
    refusesKeys: true,
    args: { playlistId: v.id("playlists"), visibility: playlistVisibility },
    result: v.null(),
  }),
  query("music.likes.list", {
    summary: "List the songs you like, newest first",
    scope: "music:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(track),
  }),
  mutation("music.likes.set", {
    summary: "Like or unlike a song",
    scope: "music:play",
    args: { trackId: v.id("tracks"), liked: v.boolean() },
    result: v.null(),
  }),
  query("music.history.list", {
    summary: "List the songs you played, most recent first",
    scope: "music:read",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(v.object({ playedAt: v.number(), track })),
  }),
  query("music.queue.get", {
    summary:
      "Show your queue: the entry playing, how many there are, shuffle, repeat, and autoplay",
    scope: "music:play",
    args: {},
    result: v.object({
      /** The entry playing; null for an empty queue. */
      current: nullable(v.id("playQueueEntries")),
      count: v.number(),
      shuffle: v.boolean(),
      repeat: repeatMode,
      /** Whether songs like the last one join when the queue runs out. */
      autoplay: v.boolean(),
    }),
  }),
  query("music.queue.list", {
    summary: "List your queue's entries in play order",
    scope: "music:play",
    args: { paginationOpts: paginationOptsValidator },
    result: paginationResultValidator(
      v.object({
        itemId: v.id("playQueueEntries"),
        /** Added by autoplay when the queue ran out, not by you. */
        autoplay: v.boolean(),
        track,
      }),
    ),
  }),
  mutation("music.queue.play", {
    summary:
      "Replace your queue with songs (2,000 at most, 1,000 kept) and play the one at --index, the first by default",
    scope: "music:play",
    args: { trackIds, index: v.optional(v.number()) },
    result: v.object({ current: v.id("playQueueEntries") }),
  }),
  mutation("music.queue.add", {
    summary:
      "Add songs to your queue: --next plays them after the current song, otherwise they go after your other queued songs (before autoplay)",
    scope: "music:play",
    args: { trackIds, next: v.optional(v.boolean()) },
    result: v.object({ itemIds: v.array(v.id("playQueueEntries")) }),
  }),
  mutation("music.queue.remove", {
    summary: "Remove an entry from your queue",
    scope: "music:play",
    args: { itemId: v.id("playQueueEntries") },
    result: v.null(),
  }),
  mutation("music.queue.move", {
    summary:
      "Move a queue entry to just after another (--after-item-id), or to the top when none is given",
    scope: "music:play",
    args: { itemId: v.id("playQueueEntries"), afterItemId: v.optional(v.id("playQueueEntries")) },
    result: v.null(),
  }),
  mutation("music.queue.clear", {
    summary: "Clear everything after the current song",
    scope: "music:play",
    args: {},
    result: v.null(),
  }),
  mutation("music.queue.jump", {
    summary: "Make a queue entry the one playing",
    scope: "music:play",
    args: { itemId: v.id("playQueueEntries") },
    result: v.null(),
  }),
  mutation("music.queue.shuffle", {
    summary: "Turn shuffle on or off",
    scope: "music:play",
    args: { on: v.boolean() },
    result: v.null(),
  }),
  mutation("music.queue.repeat", {
    summary: "Set repeat to off, all, or one",
    scope: "music:play",
    args: { mode: repeatMode },
    result: v.null(),
  }),
  mutation("music.queue.autoplay", {
    summary:
      "Turn autoplay on or off: when the queue runs out, play the same artist, then genre, then era",
    scope: "music:play",
    args: { on: v.boolean() },
    result: v.null(),
  }),
  query("music.lyrics.get", {
    summary: "Get a song's lyrics, timed line by line when its lyrics are synced",
    scope: "music:play",
    args: { trackId: v.id("tracks") },
    result: v.union(
      v.object({ status: v.literal("none") }),
      v.object({
        status: v.literal("synced"),
        source: v.literal("file"),
        main: lyricSet,
        /** The song's other lyric sets: translations, pronunciations, and other main lyrics. */
        extras: v.array(lyricSet),
      }),
      v.object({
        status: v.literal("plain"),
        source: v.literal("file"),
        main: lyricSet,
        extras: v.array(lyricSet),
      }),
    ),
  }),
  mutation("music.play.start", {
    summary: "Start a song: get a stream ticket for it in this session",
    scope: "music:play",
    args: { trackId: v.id("tracks") },
    result: v.object({
      trackId: v.id("tracks"),
      /** This start's own playback id, which `music.play.report` carries. */
      playbackId: v.string(),
      startedAt: v.number(),
      /** A personal `play` ticket for the song, naming this session; at most 6 hours. */
      ticket: v.string(),
      expiresAt: v.number(),
    }),
  }),
  mutation("music.play.report", {
    summary: "Record that a song you started is playing, once per start, in your history",
    scope: "music:play",
    args: {
      trackId: v.id("tracks"),
      /** `playbackId` from the `music.play.start` this playback came from. */
      playbackId: v.string(),
    },
    result: v.object({ recorded: v.boolean() }),
  }),
  mutation("music.play.reportOffline", {
    summary:
      "Record songs a device played offline in your history (500 at most); a play sent again records once",
    scope: "music:play",
    args: {
      plays: v.array(
        v.object({
          trackId: v.id("tracks"),
          /** When the song started, by the device's clock. */
          playedAt: v.number(),
        }),
      ),
      /** The device's clock as it sends this, so the server corrects each play for its skew. */
      sentAt: v.number(),
    },
    result: v.object({ recorded: v.number() }),
  }),
] as const satisfies ReadonlyArray<Command>;
