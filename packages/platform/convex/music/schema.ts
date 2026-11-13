import { defineTable } from "convex/server";
import { v } from "convex/values";

import { nullable } from "../movies/validators";
import { localLyricSet } from "./validators";

/** How a queue repeats: not at all, the whole queue, or the current song. */
export const repeatMode = v.union(v.literal("off"), v.literal("all"), v.literal("one"));

/**
 * The music catalog, ported from old music's `artists`, `albums`, `tracks`, and `localLyrics`
 * (ADR 0024), and what each person keeps of it: playlists, likes, plays, and the queue (ADR 0005).
 * A library's track total is its core item count, and its album, artist, and duration totals are
 * counters in `totals.ts`. LRCLIB's lookups come with a later unit. Every write goes through
 * `write.ts`, which keeps each document within its bound in `fit.ts`.
 */
export const musicTables = {
  artists: defineTable({
    libraryId: v.id("libraries"),
    /** The name as a scan first spelled it. */
    name: v.string(),
    /** The name trimmed and lowercased, so spellings that differ only in case are one artist. */
    key: v.string(),
    /** Albums of this artist that hold at least one track on disk. */
    albumCount: v.number(),
    artHash: nullable(v.string()),
    /** The name folded for accent-insensitive search. */
    searchText: v.string(),
    /**
     * Unique per row, set once by the music writer: the last field of the indexes a list walks,
     * so its cursor names one exact row however many share the fields before it (ADR 0005).
     */
    tie: v.string(),
  })
    .index("by_library_key", ["libraryId", "key", "tie"])
    /** Every library's artists by name, which the artist list pages and decides row by row. */
    .index("by_key", ["key", "tie"])
    .index("by_art", ["artHash"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["libraryId"] }),

  albums: defineTable({
    libraryId: v.id("libraries"),
    artistId: v.id("artists"),
    artistName: v.string(),
    title: v.string(),
    /** The title trimmed and lowercased; one album per artist and key. */
    key: v.string(),
    year: nullable(v.number()),
    genre: nullable(v.string()),
    artHash: nullable(v.string()),
    /** Tracks of this album on disk, and their total length. */
    trackCount: v.number(),
    durationMs: v.number(),
    /** A short format label such as `FLAC 24/96` or `MP3 320`, from the album's first track. */
    format: v.string(),
    addedAt: v.number(),
    /** Title and album artist, folded for accent-insensitive search. */
    searchText: v.string(),
    tie: v.string(),
  })
    .index("by_library_artist_key", ["libraryId", "artistId", "key"])
    .index("by_library_added", ["libraryId", "addedAt", "tie"])
    /** Every library's albums by when they were added, which the album list pages. */
    .index("by_added", ["addedAt", "tie"])
    .index("by_artist", ["artistId"])
    /** An artist's albums by year, which the artist's page lists newest first. */
    .index("by_artist_year", ["artistId", "year", "tie"])
    /** Autoplay's picks: albums of one genre near a year, then of any genre near it. */
    .index("by_library_genre", ["libraryId", "genre", "year", "tie"])
    .index("by_library_year", ["libraryId", "year", "tie"])
    .index("by_art", ["artHash"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["libraryId"] }),

  tracks: defineTable({
    libraryId: v.id("libraries"),
    albumId: v.id("albums"),
    /** The album's artist, which the track files under. */
    artistId: v.id("artists"),
    path: v.string(),
    size: v.number(),
    mtimeMs: v.number(),
    title: v.string(),
    /** The title trimmed and lowercased, for ordering. */
    titleKey: v.string(),
    /** The track's own artist, as its tags name it. */
    artistName: v.string(),
    albumTitle: v.string(),
    trackNumber: nullable(v.number()),
    discNumber: nullable(v.number()),
    /** Whole milliseconds, at least 0. */
    durationMs: v.number(),
    codec: v.string(),
    lossless: v.boolean(),
    bitrate: nullable(v.number()),
    sampleRate: nullable(v.number()),
    bitDepth: nullable(v.number()),
    artHash: nullable(v.string()),
    /** The folder artwork file the last scan saw beside this file, as `path:size:mtime`. */
    folderArt: nullable(v.string()),
    /** The lyric files the last scan read beside this file, as `name:size:mtime` joined by `/`. */
    lyricsFiles: v.string(),
    /** The version of the server's lyrics reader that read this file's lyrics. */
    lyricsReader: v.number(),
    /**
     * The size of this file's `localLyrics` row as Convex measures it, absent when it has none,
     * which a scan compares (`music/scanner:known`).
     */
    lyricsBytes: nullable(v.number()),
    /** SHA-256 of this file's lyric sets as JSON, absent when it has none. */
    lyricsHash: nullable(v.string()),
    /** Whether this file's own lyrics include synced main lyrics, which LRCLIB never replaces. */
    lyricsSynced: v.boolean(),
    /** Whether the file's tags mark it explicit, which a kid's explicit filter hides (D17). */
    explicit: v.boolean(),
    /** A scan did not find the file; the row stays, so likes and playlists keep pointing at it. */
    missing: v.boolean(),
    /** Title, artist, and album, folded for accent-insensitive search. */
    searchText: v.string(),
    tie: v.string(),
  })
    .index("by_library_path", ["libraryId", "path"])
    .index("by_library_title", ["libraryId", "missing", "titleKey", "tie"])
    /** Every library's tracks on disk by title, which the song list pages. */
    .index("by_title", ["missing", "titleKey", "tie"])
    .index("by_album", ["albumId", "discNumber", "trackNumber", "tie"])
    .index("by_artist", ["artistId"])
    .index("by_album_art", ["albumId", "missing", "artHash"])
    .index("by_artist_art", ["artistId", "missing", "artHash"])
    .index("by_art", ["artHash"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["libraryId", "missing"],
    }),

  /**
   * The lyrics a song's own files hold: the lyric files beside it and the lyrics in its tags. One
   * row per song that has any, replaced whole by every scan that reads them. It stays while the
   * song is missing and goes when the song is deleted.
   */
  localLyrics: defineTable({
    trackId: v.id("tracks"),
    /** Never empty: a song without lyrics has no row. */
    sets: v.array(localLyricSet),
  }).index("by_track", ["trackId"]),

  /**
   * A person's playlist. Who else may open it is in the core's `grants` (`playlist`): its owner
   * manages it, a person it is shared with views or edits it, and the household views it when it
   * is shared with everyone, as old music's `playlistShares` and `visibility` did.
   */
  playlists: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    description: nullable(v.string()),
    /** Its entries, and their songs' total length, as its writes keep them. */
    trackCount: v.number(),
    durationMs: v.number(),
    updatedAt: v.number(),
    tie: v.string(),
  }).index("by_owner_updated", ["ownerId", "updatedAt", "tie"]),

  /** One song on a playlist, in `position` order; one song may be on it more than once. */
  playlistItems: defineTable({
    playlistId: v.id("playlists"),
    trackId: v.id("tracks"),
    /** Sort key within the playlist; a moved entry takes one between its new neighbours. */
    position: v.number(),
    addedBy: v.id("users"),
    addedAt: v.number(),
    tie: v.string(),
  })
    .index("by_playlist_position", ["playlistId", "position", "tie"])
    .index("by_track", ["trackId"]),

  /** A song a person liked: at most one row per person and song. */
  likes: defineTable({
    userId: v.id("users"),
    trackId: v.id("tracks"),
    likedAt: v.number(),
  })
    .index("by_user_track", ["userId", "trackId"])
    .index("by_user_liked", ["userId", "likedAt"])
    .index("by_track", ["trackId"]),

  /** One play of a song in a person's history, as old music's `history` kept it. */
  plays: defineTable({
    userId: v.id("users"),
    trackId: v.id("tracks"),
    albumId: v.id("albums"),
    /** When it started, server time; an offline play's device time corrected for its skew. */
    playedAt: v.number(),
    /** The `music.play.start` it came from, so a playback records once; null when offline. */
    playbackId: nullable(v.string()),
    /** An offline play's start by its device's clock, so the same play sent again records once. */
    offlineAt: nullable(v.number()),
  })
    .index("by_user_played", ["userId", "playedAt"])
    .index("by_user_playback", ["userId", "playbackId"])
    .index("by_user_track_offline", ["userId", "trackId", "offlineAt"])
    .index("by_track", ["trackId"]),

  /**
   * A person's play queue: what plays now, and how the queue goes on. Its entries are rows of
   * `playQueueEntries` at its `generation`; replacing the queue moves it, and the old entries go
   * in scheduled pages. Where playback is, and on which device, is not kept here: remote control
   * comes with Connect.
   */
  playQueues: defineTable({
    userId: v.id("users"),
    generation: v.number(),
    /** The entry playing, or null for an empty queue. */
    current: nullable(v.id("playQueueEntries")),
    /** Entries at `generation`, which `MAX_QUEUE` bounds. */
    count: v.number(),
    shuffle: v.boolean(),
    repeat: repeatMode,
    /** Whether songs like the last one join the queue when it runs out. */
    autoplay: v.boolean(),
  }).index("by_user", ["userId"]),

  /**
   * One entry of a person's queue: its own row, so adding, moving, and removing entries from two
   * sessions at once each write only the entries they change. `order` is the play order and
   * `listOrder` the order before shuffle, which turning shuffle off restores.
   */
  playQueueEntries: defineTable({
    userId: v.id("users"),
    generation: v.number(),
    order: v.number(),
    listOrder: v.number(),
    trackId: v.id("tracks"),
    /** Added by autoplay when the queue ran out, not by the person. */
    autoplay: v.boolean(),
    tie: v.string(),
  })
    .index("by_queue_order", ["userId", "generation", "order", "tie"])
    .index("by_queue_list", ["userId", "generation", "listOrder", "tie"])
    .index("by_queue_autoplay", ["userId", "generation", "autoplay", "order", "tie"])
    .index("by_track", ["trackId"]),
};
