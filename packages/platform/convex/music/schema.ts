import { defineTable } from "convex/server";
import { v } from "convex/values";

import { nullable } from "../movies/validators";
import { localLyricSet } from "./validators";

/**
 * The music catalog, ported from old music's `artists`, `albums`, `tracks`, and `localLyrics`
 * (ADR 0024). A library's track total is its core item count, and its album, artist, and duration
 * totals are counters in `totals.ts`. What each person keeps of the catalog (playlists, likes,
 * history, the queue) and LRCLIB's lookups come with later units. Every write goes through
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
    .index("by_artist", ["artistId"])
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
     * The size of this file's `localLyrics` row as Convex measures it, absent when it has none.
     * The writer sets it with the row, so a call charges the row's bytes before reading it.
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
};
