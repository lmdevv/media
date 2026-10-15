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
  })
    .index("email", ["email"])
    .index("by_role", ["role"]),

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
    trackCount: v.number(),
    albumCount: v.number(),
    artistCount: v.number(),
    durationMs: v.number(),
  }).index("by_owner", ["ownerId"]),

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
    missing: v.boolean(),
    /** Title, artist, and album, folded for accent-insensitive search. */
    searchText: v.string(),
  })
    .index("by_library_path", ["libraryId", "path"])
    .index("by_album", ["albumId", "discNumber", "trackNumber"])
    .index("by_artist", ["artistId"])
    .index("by_title", ["missing", "titleKey"])
    .index("by_library_title", ["libraryId", "missing", "titleKey"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["libraryId", "missing"],
    }),

  playlists: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    trackCount: v.number(),
    durationMs: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId", "updatedAt"]),

  playlistItems: defineTable({
    playlistId: v.id("playlists"),
    trackId: v.id("tracks"),
    position: v.number(),
  })
    .index("by_playlist", ["playlistId", "position"])
    .index("by_track", ["trackId"]),

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
    queue: v.array(v.id("tracks")),
    /** The queue before shuffle, restored when shuffle turns off. */
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
     * lease ends, since claiming resets it and it counts saved files). A file that crashes the
     * scanner stops it before its batch saves every time, so the job fails after a few; a scan
     * that restarts for other reasons (a deploy) still saves batches and keeps retrying.
     */
    stalls: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_status_finished", ["status", "finishedAt"])
    .index("by_library_status", ["libraryId", "status"]),

  /** Progress of each data migration in `migrations.ts`, so an interrupted one resumes. */
  migrations: defineTable({
    name: v.string(),
    /** Where the next batch starts; null before the first batch. */
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }).index("by_name", ["name"]),
});
