import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** See `Role` in `@music/commands/models` and `permissions.ts`. */
const role = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("guest"),
);

/** Ownership only moves by transfer, so no invite gives it. */
const inviteRole = v.union(v.literal("admin"), v.literal("member"), v.literal("guest"));

const visibility = v.union(v.literal("shared"), v.literal("restricted"), v.literal("private"));

export const jobStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const repeatMode = v.union(v.literal("off"), v.literal("all"), v.literal("one"));

export const deviceKind = v.union(v.literal("web"), v.literal("phone"), v.literal("cli"));

export const playlistVisibility = v.union(v.literal("private"), v.literal("shared"));

export const playlistRole = v.union(v.literal("viewer"), v.literal("collaborator"));

export const jamStatus = v.union(v.literal("active"), v.literal("ended"));

export const jamEndReason = v.union(
  v.literal("host"),
  v.literal("host_offline"),
  v.literal("idle"),
);

export const jamMemberStatus = v.union(
  v.literal("pending"),
  v.literal("joined"),
  v.literal("left"),
  v.literal("removed"),
);

export const jamSettings = v.object({
  join: v.union(v.literal("open"), v.literal("approval"), v.literal("locked")),
  membersCanAdd: v.boolean(),
  addLimit: v.union(v.number(), v.null()),
  membersCanControl: v.boolean(),
  membersCanEdit: v.union(v.literal("none"), v.literal("own"), v.literal("any")),
  listenAlong: v.boolean(),
});

/**
 * One queue entry. `id` is unique within its queue and never reused (`nextItemId` counts on), so a
 * command naming it reaches this entry however the queue changed since the client saw it.
 */
export const queueItem = v.object({
  id: v.string(),
  trackId: v.id("tracks"),
  /** Missing on entries converted from queues stored before entries had IDs. */
  addedBy: v.optional(v.id("users")),
  /** Set on entries autoplay added when the queue ran out. */
  autoplay: v.optional(v.boolean()),
});

const lyricWord = v.object({
  text: v.string(),
  startMs: v.number(),
  endMs: v.union(v.number(), v.null()),
});

const lyricLine = v.object({
  text: v.string(),
  startMs: v.number(),
  endMs: v.union(v.number(), v.null()),
  words: v.union(v.array(lyricWord), v.null()),
  voice: v.union(v.string(), v.null()),
});

/**
 * One of a song's own lyric sets as `LocalLyricSet` in `@music/commands/lyrics` encodes it: from
 * a file beside the song or a tag inside it, never LRCLIB. The validator checks its shape; the
 * schema's refinements (language tags, non-empty text) are checked where it is written and read
 * (`lib/lyrics.ts`).
 */
export const localLyricSet = v.object({
  kind: v.union(v.literal("main"), v.literal("translation"), v.literal("pronunciation")),
  lang: v.union(v.string(), v.null()),
  origin: v.union(
    v.object({
      _tag: v.literal("Sidecar"),
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
      _tag: v.literal("Embedded"),
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
    v.object({ _tag: v.literal("Synced"), lines: v.array(lyricLine) }),
    v.object({ _tag: v.literal("Plain"), text: v.string() }),
  ),
});

export default defineSchema({
  ...authTables,

  /**
   * Convex Auth's sessions, plus the generation of the person's sessions each was opened in
   * (`users.sessionGeneration`); sessions [music] opens itself (password sign-in, reset, API
   * keys) record it, and one from an older generation no longer counts (`isStale`).
   */
  authSessions: defineTable({
    userId: v.id("users"),
    expirationTime: v.number(),
    generation: v.optional(v.number()),
  }).index("userId", ["userId"]),

  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    /** Missing on accounts from before roles were stored; they read as `member`. */
    role: v.optional(role),
    /** Set while the account is suspended: it cannot sign in, and its keys stop working. */
    suspendedAt: v.optional(v.number()),
    /**
     * Sessions created up to this time no longer count, whatever their tokens say. Suspension,
     * unsuspension, and a password reset move it forward, which ends every session at once
     * however many there are; the rows themselves are purged in batches afterwards.
     */
    sessionsValidAfter: v.optional(v.number()),
    /**
     * Bumped with `sessionsValidAfter` whenever every session ends. A session opened with the
     * password must have checked it in the generation it records, so one whose check raced a
     * reset can't outlive it, whatever the clocks say.
     */
    sessionGeneration: v.optional(v.number()),
    /**
     * API keys created up to this time no longer work, nor do the sessions they opened. Demotion
     * to guest sets it, so a later promotion can't revive keys the batched revocation
     * (`people:revokeKeys`) has not reached yet, and so does a password reset, since whoever had
     * the account may have made keys.
     */
    keysValidAfter: v.optional(v.number()),
    /** Carried from the sign-up form to `createOrUpdateUser`; never stored on a created user. */
    inviteCode: v.optional(v.string()),
    /** Like `inviteCode`, for a guest account made from a Jam link; never stored either. */
    jamCode: v.optional(v.string()),
    /** Set on guest accounts made from a Jam link rather than an invite. */
    joinedViaJam: v.optional(v.id("jams")),
  })
    .index("email", ["email"])
    .index("by_role", ["role"])
    .index("by_jam_guest", ["joinedViaJam", "role"]),

  invites: defineTable({
    code: v.string(),
    email: v.optional(v.string()),
    role: inviteRole,
    createdBy: v.id("users"),
    expiresAt: v.number(),
    acceptedBy: v.optional(v.id("users")),
    acceptedAt: v.optional(v.number()),
    revoked: v.boolean(),
  })
    .index("by_code", ["code"])
    .index("by_expires", ["expiresAt"])
    .index("by_accepted", ["acceptedAt"])
    .index("by_creator", ["createdBy"]),

  /** One-time password reset links an admin made. Only the token's hash is stored. */
  passwordResets: defineTable({
    userId: v.id("users"),
    /** SHA-256 of the token, hex. */
    hash: v.string(),
    createdBy: v.optional(v.id("users")),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_user", ["userId"])
    .index("by_expires", ["expiresAt"])
    .index("by_creator", ["createdBy"]),

  apiKeys: defineTable({
    userId: v.id("users"),
    name: v.string(),
    prefix: v.string(),
    /** SHA-256 of the key, hex. The key itself is shown once and never stored. */
    hash: v.string(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    /** The auth session every sign-in with this key shares; revoking the key deletes it. */
    sessionId: v.optional(v.id("authSessions")),
  })
    .index("by_hash", ["hash"])
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"])
    .index("by_revoked", ["revokedAt"])
    .index("by_user_last_used", ["userId", "lastUsedAt"]),

  /**
   * Every request reads every library to decide what the viewer may read, so this row holds only
   * what rarely changes. The counters a scan moves with every batch live in `libraryStats`.
   */
  libraries: defineTable({
    name: v.string(),
    path: v.string(),
    /**
     * The folder `path` resolves to through links and mounts, as the media service last found it
     * before a scan (`media:claimRoot`). No two libraries' real folders may overlap. Missing until
     * the first scan after the library was added or this field was.
     */
    realPath: v.optional(v.string()),
    /**
     * The claimed folder's identity and its parents' up to `/` (`<device>:<inode>`, see
     * `@music/commands/folder-ids`), which a bind mount can't disguise. Missing on claims made
     * before it was recorded; the next scan fills it in. Cleared with `realPath` when a claim is
     * refused, so nothing of the library streams until a scan claims it again.
     */
    rootIds: v.optional(v.array(v.string())),
    /**
     * Where the claimed folder is on its file system (`<major>:<minor>:/path`, from the media
     * service's mount table), which a bind mount of a subfolder can't disguise. Missing without a
     * mount table, or on claims from before it was recorded. Cleared with `realPath`.
     */
    fsPath: v.optional(v.string()),
    /**
     * The boot of the media service's machine that read `rootIds` and `fsPath`. Device numbers
     * and inodes can change or be reused across reboots, so another library's identities are
     * compared only when read in the same boot; claims from another boot are made again within
     * seconds by the media service's claim pass. Cleared with `realPath`.
     */
    bootId: v.optional(v.string()),
    visibility,
    ownerId: v.id("users"),
    lastScanAt: v.optional(v.number()),
    /**
     * Counters from before they had their own row (`libraryStats`). The next change to the
     * counts, or the `splitLibraryStats` migration, moves them there and clears them.
     */
    trackCount: v.optional(v.number()),
    albumCount: v.optional(v.number()),
    artistCount: v.optional(v.number()),
    durationMs: v.optional(v.number()),
  }).index("by_owner", ["ownerId"]),

  /** A library's playable songs, albums with songs, artists with albums, and total length. */
  libraryStats: defineTable({
    libraryId: v.id("libraries"),
    trackCount: v.number(),
    albumCount: v.number(),
    artistCount: v.number(),
    durationMs: v.number(),
  }).index("by_library", ["libraryId"]),

  /**
   * People added to a library. They can listen to it while it is `restricted`, or, for guests,
   * `shared`; a `private` library ignores the list but keeps it for when it opens again.
   */
  libraryAccess: defineTable({
    libraryId: v.id("libraries"),
    userId: v.id("users"),
    grantedBy: v.id("users"),
  })
    .index("by_user", ["userId", "libraryId"])
    .index("by_library", ["libraryId", "userId"]),

  artists: defineTable({
    libraryId: v.id("libraries"),
    name: v.string(),
    /** Lowercased name used to merge spellings that differ only in case. */
    key: v.string(),
    albumCount: v.number(),
    artHash: v.optional(v.string()),
    /**
     * The name folded for accent-insensitive search. Every write sets it; it is optional only so
     * artists stored before it existed still deploy, and the `foldArtistSearchText` migration
     * fills them in.
     */
    searchText: v.optional(v.string()),
  })
    .index("by_library_key", ["libraryId", "key"])
    .index("by_key", ["key"])
    .index("by_art", ["artHash"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["libraryId"] }),

  albums: defineTable({
    libraryId: v.id("libraries"),
    artistId: v.id("artists"),
    artistName: v.string(),
    title: v.string(),
    key: v.string(),
    year: v.optional(v.number()),
    genre: v.optional(v.string()),
    artHash: v.optional(v.string()),
    trackCount: v.number(),
    durationMs: v.number(),
    format: v.string(),
    addedAt: v.number(),
    /** Title and artist, folded for accent-insensitive search. */
    searchText: v.string(),
  })
    .index("by_library_artist_key", ["libraryId", "artistId", "key"])
    .index("by_artist", ["artistId"])
    .index("by_added", ["addedAt"])
    .index("by_library_added", ["libraryId", "addedAt"])
    // Autoplay picks songs of the same genre, then of albums from around the same year, in each
    // library the listener can read.
    .index("by_library_genre", ["libraryId", "genre", "year"])
    .index("by_library_year", ["libraryId", "year"])
    .index("by_art", ["artHash"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["libraryId"] }),

  tracks: defineTable({
    libraryId: v.id("libraries"),
    albumId: v.id("albums"),
    artistId: v.id("artists"),
    path: v.string(),
    size: v.number(),
    mtimeMs: v.number(),
    title: v.string(),
    titleKey: v.string(),
    artistName: v.string(),
    albumTitle: v.string(),
    trackNumber: v.optional(v.number()),
    discNumber: v.optional(v.number()),
    durationMs: v.number(),
    codec: v.string(),
    lossless: v.boolean(),
    bitrate: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    bitDepth: v.optional(v.number()),
    artHash: v.optional(v.string()),
    /**
     * The folder artwork file (`cover.jpg` and the like) the last scan saw beside this file, as
     * `path:size:mtime`, so replacing it rescans the track. Absent where the folder has none, and
     * on tracks scanned before it existed, which the next scan fills in.
     */
    folderArt: v.optional(v.string()),
    /**
     * The lyric files the last scan read beside this file, as `name:size:mtime` joined by `/`,
     * empty when it had none, so adding, editing, or removing one reads its lyrics again. Absent
     * on tracks scanned before lyrics were read.
     */
    lyricsFiles: v.optional(v.string()),
    /**
     * The version of the media service's lyrics reader that read this file's lyrics. A newer
     * reader reads them again; absent on tracks scanned before lyrics were read, so every one of
     * those is read once.
     */
    lyricsReader: v.optional(v.number()),
    /**
     * The size of this file's `localLyrics` sets as JSON, absent when it has none. Replacing or
     * deleting them reads them, so scans and purges size their batches by it.
     */
    lyricsBytes: v.optional(v.number()),
    missing: v.boolean(),
    /** Title, artist, and album, folded for accent-insensitive search. */
    searchText: v.string(),
  })
    .index("by_library_path", ["libraryId", "path"])
    .index("by_album", ["albumId", "discNumber", "trackNumber"])
    .index("by_artist", ["artistId"])
    .index("by_title", ["missing", "titleKey"])
    .index("by_library_title", ["libraryId", "missing", "titleKey"])
    // Where an album or artist finds other art when its own goes, in a few reads however many
    // songs it has, and whether any song still uses a cover.
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

  playlists: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    trackCount: v.number(),
    durationMs: v.number(),
    updatedAt: v.number(),
    /** Missing on playlists from before sharing; they read as `private`. */
    visibility: v.optional(playlistVisibility),
  }).index("by_owner", ["ownerId", "updatedAt"]),

  playlistItems: defineTable({
    playlistId: v.id("playlists"),
    trackId: v.id("tracks"),
    /** Sort key within the playlist. Moving an entry gives it a key between its new neighbours. */
    position: v.number(),
    /** Missing on entries from before sharing; the playlist's owner added those. */
    addedBy: v.optional(v.id("users")),
  })
    .index("by_playlist", ["playlistId", "position"])
    .index("by_track", ["trackId"]),

  /** People a playlist is shared with by name, and what each may do with it. */
  playlistShares: defineTable({
    playlistId: v.id("playlists"),
    userId: v.id("users"),
    role: playlistRole,
    sharedBy: v.id("users"),
  })
    .index("by_playlist", ["playlistId", "userId"])
    .index("by_user", ["userId"]),

  likes: defineTable({
    userId: v.id("users"),
    trackId: v.id("tracks"),
  })
    .index("by_user_track", ["userId", "trackId"])
    .index("by_user", ["userId"])
    .index("by_track", ["trackId"]),

  history: defineTable({
    userId: v.id("users"),
    trackId: v.id("tracks"),
    albumId: v.id("albums"),
    deviceId: v.string(),
    /**
     * When the song started, by the device's clock; set only on plays a device recorded offline.
     */
    playedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_track", ["trackId"]),

  devices: defineTable({
    userId: v.id("users"),
    deviceId: v.string(),
    name: v.string(),
    kind: deviceKind,
    lastSeenAt: v.number(),
  })
    .index("by_user_device", ["userId", "deviceId"])
    .index("by_user_last_seen", ["userId", "lastSeenAt"])
    .index("by_last_seen", ["lastSeenAt"]),

  /**
   * A song, album, or playlist someone keeps downloaded on one device. The device owns the files;
   * this row is only the intent, which any client (the device, the CLI, an agent) may change.
   */
  downloadPins: defineTable({
    userId: v.id("users"),
    /**
     * The device's own ID (`devices.deviceId`), not a reference: a pin outlives the device row,
     * and the prune keeps a device that holds one (`maintenance:pruneStaleDevices`).
     */
    deviceId: v.string(),
    target: v.union(
      v.object({ kind: v.literal("track"), id: v.id("tracks") }),
      v.object({ kind: v.literal("album"), id: v.id("albums") }),
      v.object({ kind: v.literal("playlist"), id: v.id("playlists") }),
    ),
  })
    .index("by_user_device", ["userId", "deviceId", "target.kind", "target.id"])
    // A retag that empties an album moves its pins to the album its songs went to.
    .index("by_target", ["target.kind", "target.id"]),

  /**
   * Where a user's playback is: the device, the position, and the volume. Players report the
   * position every few seconds, so these fields live apart from the queue: a report rewrites only
   * this row, and nothing that reads the queue runs again.
   */
  playbackSessions: defineTable({
    userId: v.id("users"),
    activeDeviceId: v.optional(v.string()),
    positionMs: v.number(),
    playing: v.boolean(),
    updatedAt: v.number(),
    volume: v.number(),
    /** When a command last moved playback to another song (play, skip, jump, remove). */
    movedAt: v.optional(v.number()),
    /**
     * Queue fields from before the queue had its own row (`playbackQueues`). The next write to a
     * user's queue, or the `splitPlaybackQueues` migration, moves them there and clears them.
     */
    queue: v.optional(v.array(v.id("tracks"))),
    unshuffled: v.optional(v.array(v.id("tracks"))),
    index: v.optional(v.number()),
    shuffle: v.optional(v.boolean()),
    repeat: v.optional(repeatMode),
    reportedTrackId: v.optional(v.id("tracks")),
  })
    .index("by_user", ["userId"])
    .index("by_playing", ["playing"]),

  /** A user's queue and play order. It changes when the song changes, not with the position. */
  playbackQueues: defineTable({
    userId: v.id("users"),
    /** The entries in play order. Missing on rows from before entries had IDs (see `queue`). */
    items: v.optional(v.array(queueItem)),
    /** The entry IDs in their order before shuffle, restored when shuffle turns off. */
    unshuffledItems: v.optional(v.array(v.string())),
    /** The number in the next entry's ID. */
    nextItemId: v.optional(v.number()),
    /** Whether autoplay adds similar songs when the queue runs out; missing reads as on. */
    autoplay: v.optional(v.boolean()),
    /**
     * Song IDs from before entries had IDs. The next write to the queue, or the `queueItems`
     * migration, turns them into `items` and clears them.
     */
    queue: v.optional(v.array(v.id("tracks"))),
    unshuffled: v.optional(v.array(v.id("tracks"))),
    index: v.number(),
    shuffle: v.boolean(),
    repeat: repeatMode,
    /** The song whose play history last recorded; cleared when a song starts again. */
    reportedTrackId: v.optional(v.id("tracks")),
  }).index("by_user", ["userId"]),

  jobs: defineTable({
    kind: v.literal("scan"),
    status: jobStatus,
    libraryId: v.id("libraries"),
    createdBy: v.id("users"),
    done: v.number(),
    total: v.optional(v.number()),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
    workerId: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    /**
     * How many leases in a row expired before the worker saved a single batch (`done` is 0 when a
     * lease ends, since claiming resets it and it counts saved files) or found that no file
     * changed (`total` is 0; claiming clears it). A file that crashes the
     * scanner stops it before its batch saves every time, so the job fails after a few; a scan
     * that restarts for other reasons (a deploy) still saves batches and keeps retrying.
     */
    stalls: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_status_finished", ["status", "finishedAt"])
    .index("by_library_status", ["libraryId", "status"]),

  /**
   * A Jam: a live listening session shared from its host's playback. People who join play the
   * host's queue (see `lib/jams.ts`); their own playback stays as it was.
   */
  jams: defineTable({
    hostId: v.id("users"),
    /** The secret in the Jam's link. Regenerating it makes the old link stop working. */
    code: v.string(),
    status: jamStatus,
    endedReason: v.optional(jamEndReason),
    endedAt: v.optional(v.number()),
    settings: jamSettings,
    /**
     * When the host last ran a command (to the minute; see `noteHostActivity`). With their
     * devices' heartbeats it tells whether the host is still there; the session's own update
     * time doesn't, since people in the Jam move it too.
     */
    hostActiveAt: v.optional(v.number()),
    /**
     * The link code in use when the host last removed or turned someone away. While it is still
     * the code, an open Jam asks the host about everyone new (`joinPolicy`), so a guest removed
     * can't come straight back with a new account; a new link lets people in again.
     */
    removedUnderCode: v.optional(v.string()),
  })
    .index("by_code", ["code"])
    .index("by_host_status", ["hostId", "status"])
    .index("by_status", ["status"]),

  /** Someone in a Jam, or asking to join one. A person is `joined` to at most one Jam at a time. */
  jamMembers: defineTable({
    jamId: v.id("jams"),
    userId: v.id("users"),
    status: jamMemberStatus,
    /** Listening along: the Jam plays on `deviceId`, one of their own devices. */
    listening: v.boolean(),
    deviceId: v.optional(v.string()),
    /**
     * The link code in use when the host removed them or turned them away: that link won't let
     * them back in, but a regenerated one would.
     */
    blockedCode: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_jam", ["jamId", "status"])
    .index("by_jam_user", ["jamId", "userId"])
    .index("by_user", ["userId", "updatedAt"])
    .index("by_user_status", ["userId", "status"]),

  /** Server-wide settings admins change; one row, created on first change. */
  serverSettings: defineTable({
    jamGuestAccounts: v.boolean(),
  }),

  /** Progress of each data migration in `migrations.ts`, so an interrupted one resumes. */
  migrations: defineTable({
    name: v.string(),
    /** Where the next batch starts; null before the first batch. */
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }).index("by_name", ["name"]),
});
