import { defineTable } from "convex/server";
import { v } from "convex/values";

import { nullable } from "../movies/validators";
import { artistCredit, creditOverride, localLyricSet, lrclibAnswer } from "./validators";

/** How a queue repeats: not at all, the whole queue, or the current song. */
export const repeatMode = v.union(v.literal("off"), v.literal("all"), v.literal("one"));

/**
 * The music catalog (`artists`, `albums`, `tracks`, and `localLyrics`; ADR 0024), the artist
 * credits that link each song and album to every artist it credits, and what each person keeps of
 * it: playlists, likes, plays, and the queue (ADR 0005). A library's track total is its core item
 * count, and its album, artist, and duration totals are counters in `totals.ts`. LRCLIB's answers
 * are in `lrclibLyrics`. Every write goes through `write.ts`, which keeps each document within its
 * bound in `fit.ts`.
 *
 * Rows a release before artist credits wrote lack the credit fields, which are optional until
 * every install's first scan after it rewrote them (ADR 0012, "a shape change to stored rows").
 */
export const musicTables = {
  artists: defineTable({
    libraryId: v.id("libraries"),
    /** The name as a scan first spelled it. */
    name: v.string(),
    /** The name trimmed and lowercased, so spellings that differ only in case are one artist. */
    key: v.string(),
    /** Albums crediting this artist that hold at least one track on disk. */
    albumCount: v.number(),
    /** Tracks on disk crediting this artist; absent, as 0, on a row no credit has touched yet. */
    trackCount: v.optional(v.number()),
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
    /** The album's first credited artist. */
    artistId: v.id("artists"),
    /** The album artist as the tags name it, which the album files under. */
    artistName: v.string(),
    /**
     * The key of `artistName`: one album per library, `artistKey`, `creditsTagged`, and `key`,
     * however the evidence splits the name.
     */
    artistKey: v.optional(v.string()),
    /** Every artist the album credits, in order, from its album artist (`artistCredits`). */
    credits: v.optional(v.array(artistCredit)),
    /** Whether `credits` are the separate values of its tags, which no evidence changes. */
    creditsTagged: v.optional(v.boolean()),
    title: v.string(),
    /** The title trimmed and lowercased; one album per album artist and key. */
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
    .index("by_library_filing", ["libraryId", "artistKey", "creditsTagged", "key"])
    /** How a release before artist credits found an album, which its first scan after adopts. */
    .index("by_library_artist_key", ["libraryId", "artistId", "key"])
    .index("by_library_added", ["libraryId", "addedAt", "tie"])
    /** Every library's albums by when they were added, which the album list pages. */
    .index("by_added", ["addedAt", "tie"])
    .index("by_artist", ["artistId"])
    /** An artist's albums a release before artist credits wrote, by year (no `artistKey`). */
    .index("by_artist_year", ["artistId", "artistKey", "year", "tie"])
    /** Autoplay's picks: albums of one genre near a year, then of any genre near it. */
    .index("by_library_genre", ["libraryId", "genre", "year", "tie"])
    .index("by_library_year", ["libraryId", "year", "tie"])
    .index("by_art", ["artHash"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["libraryId"] }),

  tracks: defineTable({
    libraryId: v.id("libraries"),
    albumId: v.id("albums"),
    /** The track's first credited artist. */
    artistId: v.id("artists"),
    /** Every artist the track credits, in order: its artist, then its title's featured artists. */
    credits: v.optional(v.array(artistCredit)),
    /** Whether `credits` are the separate values of its tags, which no evidence changes. */
    creditsTagged: v.optional(v.boolean()),
    /** The version of the server's tag reader that read its tags; absent before credits. */
    tagsReader: v.optional(v.number()),
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
    /** Tracks by first credited artist; with no `tagsReader`, those written before credits. */
    .index("by_artist", ["artistId", "tagsReader"])
    .index("by_album_art", ["albumId", "missing", "artHash"])
    .index("by_artist_art", ["artistId", "missing", "artHash"])
    .index("by_art", ["artHash"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["libraryId", "missing"],
    }),

  /**
   * A credit string as one library's tags write it: a song's or an album's artist tag, or a
   * featured-artist list in a title (ADR 0024, "Artist credits"). A string of one part is
   * evidence: its name is known on its own in the library. A combined string's `artists` is how it
   * resolves now, which every song and album it names follows. The row goes with its last use.
   */
  artistCredits: defineTable({
    libraryId: v.id("libraries"),
    /** The string trimmed and lowercased (`keyOf`). */
    key: v.string(),
    /** The string as a scan first spelled it. */
    text: v.string(),
    /** Whether the string has two or more parts it may split into (`isCombined`). */
    combined: v.boolean(),
    /** Songs and albums whose tags name it as a whole credit. */
    uses: v.number(),
    /** The artists it credits now, in order: itself, or the parts the evidence split it into. */
    artists: v.array(v.string()),
  })
    .index("by_library_key", ["libraryId", "key"])
    /** A library's combined credits by key, which its managers review. */
    .index("by_library_combined", ["libraryId", "combined", "key"]),

  /**
   * One part of a combined credit string, so a change in what the library knows of a name finds
   * every combined credit that name is part of.
   */
  creditParts: defineTable({
    libraryId: v.id("libraries"),
    partKey: v.string(),
    creditKey: v.string(),
  }).index("by_library_part", ["libraryId", "partKey", "creditKey"]),

  /**
   * A song whose tags name a combined credit string, so a credit that resolves anew rewrites the
   * credits of every song it names. Albums are found by their `artistKey`.
   */
  creditTracks: defineTable({
    libraryId: v.id("libraries"),
    creditKey: v.string(),
    trackId: v.id("tracks"),
  }).index("by_library_credit", ["libraryId", "creditKey", "trackId"]),

  /**
   * A manager's correction of how one library resolves a credit string: `together` keeps it one
   * artist, also as a run inside longer credits, and `split` splits it whatever the evidence.
   */
  creditOverrides: defineTable({
    libraryId: v.id("libraries"),
    key: v.string(),
    /** The string as the manager typed it. */
    text: v.string(),
    mode: creditOverride,
  }).index("by_library_key", ["libraryId", "key"]),

  /** A track crediting an artist, once per artist, which the artist's page lists by title. */
  trackArtists: defineTable({
    libraryId: v.id("libraries"),
    artistId: v.id("artists"),
    trackId: v.id("tracks"),
    /** The track's `titleKey`, kept with it. */
    titleKey: v.string(),
    tie: v.string(),
  })
    .index("by_artist_title", ["artistId", "titleKey", "tie"])
    .index("by_track", ["trackId"]),

  /** An album crediting an artist, once per artist, which the artist's page lists newest first. */
  albumArtists: defineTable({
    libraryId: v.id("libraries"),
    artistId: v.id("artists"),
    albumId: v.id("albums"),
    /** The album's `year`, kept with it. */
    year: nullable(v.number()),
    tie: v.string(),
  })
    .index("by_artist_year", ["artistId", "year", "tie"])
    .index("by_album", ["albumId"]),

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
   * What LRCLIB answered for a song, one row per song it was looked up for; the lookups themselves
   * are `music.lyrics` jobs (ADR 0012). The row answers only while the song's tags still make
   * `revision`, so a retagged song is looked up again. Found lyrics and an instrumental answer
   * stand; a miss stands for 30 days. It goes when the song is deleted.
   */
  lrclibLyrics: defineTable({
    trackId: v.id("tracks"),
    /** SHA-256 of the lookup key the answer is for (`music/lyricLookups.ts`). */
    revision: v.string(),
    /** When LRCLIB answered. */
    checkedAt: v.number(),
    answer: lrclibAnswer,
  }).index("by_track", ["trackId"]),

  /**
   * The server's lyrics settings: one row at most, and none means LRCLIB lookups are on, the
   * default.
   */
  lyricsSettings: defineTable({
    /** Whether the server looks lyrics up on LRCLIB; off, no request reaches it. */
    remote: v.boolean(),
  }),

  /**
   * A person's playlist. Who else may open it is in the core's `grants` (`playlist`): its owner
   * manages it, a person it is shared with views or edits it, and the household views it when it is
   * shared with everyone.
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
    /**
     * The song's length when it was added, which the playlist's total gained, so taking the entry
     * off takes away what it added even after a rescan changed the song's length.
     */
    durationMs: v.number(),
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

  /** One play of a song in a person's history. */
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
    /**
     * Moves on with every change to the queue or its entries, so a client can tell a listing read
     * under this queue from one read under another (ADR 0018).
     */
    revision: v.number(),
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
