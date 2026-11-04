import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { identityTables } from "./core/identity";

import {
  migrationCheckpoint,
  migrationImported,
  storedMigrationPlan,
} from "./lib/migrationValidators";
import {
  apiKeyScope,
  artwork,
  assignableRole,
  backupTrigger,
  communityRating,
  creditKind,
  deviceCodeState,
  deviceScope,
  externalIds,
  externalSubtitle,
  jobKind,
  jobPayload,
  jobProgress,
  jobStatus,
  libraryAccess,
  libraryKind,
  matchStatus,
  metadataOverrides,
  migrationSource,
  nullable,
  playbackMode,
  playbackSessionStatus,
  playbackState,
  probe,
  ratings,
  roomPresence,
  roomRole,
  roomStatus,
  scope,
  showStatus,
  storedRoomNext,
  titleKind,
  trailer,
  trickplayState,
} from "./lib/validators";

/**
 * What a restricted session may do. Password sessions have no grant and hold every scope their
 * role allows. The grant lives on the session row itself, so deleting the session deletes the
 * grant and a restricted session can never outlive it as an unrestricted one.
 */
export const sessionGrant = v.object({
  kind: v.union(v.literal("apikey"), v.literal("device")),
  scopes: v.array(scope),
  label: v.string(),
  apiKeyId: v.optional(v.id("apiKeys")),
  deviceCodeId: v.optional(v.id("deviceCodes")),
});

export default defineSchema({
  ...authTables,

  ...identityTables,

  invites: defineTable({
    /** SHA-256 of the invite code, hex. The code is shown once and never stored. */
    codeHash: v.string(),
    email: nullable(v.string()),
    role: assignableRole,
    createdBy: v.id("users"),
    expiresAt: v.number(),
    acceptedBy: v.optional(v.id("users")),
    acceptedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  }).index("by_code_hash", ["codeHash"]),

  apiKeys: defineTable({
    userId: v.id("users"),
    name: v.string(),
    prefix: v.string(),
    /** SHA-256 of the key, hex. The key itself is shown once and never stored. */
    hash: v.string(),
    scopes: v.array(apiKeyScope),
    expiresAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    /** The auth session every sign-in with this key shares; revoking the key deletes it. */
    sessionId: v.optional(v.id("authSessions")),
    /** The media service's key, created by `scripts/configure.ts`. Holds `media-service` only. */
    service: v.optional(v.boolean()),
  })
    .index("by_hash", ["hash"])
    .index("by_user", ["userId"]),

  deviceCodes: defineTable({
    /** SHA-256 of the secret device code, hex. */
    deviceCodeHash: v.string(),
    userCode: v.string(),
    clientName: v.string(),
    status: deviceCodeState,
    expiresAt: v.number(),
    decidedBy: v.optional(v.id("users")),
    scopes: v.optional(v.array(deviceScope)),
    consumedAt: v.optional(v.number()),
  })
    .index("by_hash", ["deviceCodeHash"])
    .index("by_user_code", ["userCode"])
    .index("by_expires", ["expiresAt"]),

  profiles: defineTable({
    userId: v.id("users"),
    name: v.string(),
    avatar: v.string(),
    kids: v.boolean(),
    maxAgeRating: nullable(v.number()),
    /** PBKDF2-SHA256 of the PIN with `pinSalt`, base64url. */
    pinHash: v.optional(v.string()),
    pinSalt: v.optional(v.string()),
    pinFailures: v.number(),
    pinLockedUntil: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  libraries: defineTable({
    name: v.string(),
    kind: libraryKind,
    roots: v.array(v.string()),
    access: libraryAccess,
    createdBy: v.id("users"),
    titleCount: v.number(),
    lastScanAt: nullable(v.number()),
    /** Scans queue scrub thumbnails for new and changed files; absent means yes. */
    trickplay: v.optional(v.boolean()),
  }),

  libraryGrants: defineTable({
    userId: v.id("users"),
    libraryId: v.id("libraries"),
  })
    .index("by_user", ["userId"])
    .index("by_library", ["libraryId"]),

  titles: defineTable({
    libraryId: v.id("libraries"),
    kind: titleKind,
    /** Identifies the title within its library across scans, such as `tmdb:603`. */
    matchKey: v.string(),
    name: v.string(),
    sortName: v.string(),
    /** Lowercased sort name for ordering. */
    sortKey: v.string(),
    year: nullable(v.number()),
    overview: nullable(v.string()),
    tagline: nullable(v.string()),
    genres: v.array(v.string()),
    certification: nullable(v.string()),
    ageRating: nullable(v.number()),
    runtimeMs: nullable(v.number()),
    artwork,
    externalIds,
    matchStatus,
    /** Admin edits; presentation prefers them and scans never overwrite them. */
    overrides: v.optional(metadataOverrides),
    /** Files of this title (or its episodes) present on disk. Zero means unavailable. */
    presentFileCount: v.number(),
    addedAt: v.number(),
    updatedAt: v.number(),
    searchText: v.string(),
    originalName: v.optional(nullable(v.string())),
    releaseDate: v.optional(nullable(v.string())),
    status: v.optional(nullable(showStatus)),
    originalLanguage: v.optional(nullable(v.string())),
    studios: v.optional(v.array(v.string())),
    countries: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    ratings: v.optional(ratings),
    trailer: v.optional(nullable(trailer)),
    /** TMDB IDs the provider recommends, best first; `titles.similar` resolves them on read. */
    recommendations: v.optional(v.array(v.string())),
    /** Digest of the title's own credits, so unchanged rescans skip rewriting them. */
    creditsHash: v.optional(v.string()),
    /** Digest of the collection the title's metadata names, likewise. */
    collectionHash: v.optional(v.string()),
  })
    .index("by_library_match", ["libraryId", "matchKey"])
    .index("by_kind_tmdb", ["kind", "externalIds.tmdb"])
    .index("by_library", ["libraryId"])
    .index("by_library_status", ["libraryId", "matchStatus"])
    .index("by_library_sort", ["libraryId", "sortKey"])
    .index("by_library_added", ["libraryId", "addedAt"])
    .index("by_library_year", ["libraryId", "year"])
    .index("by_kind_sort", ["kind", "sortKey"])
    .index("by_kind_added", ["kind", "addedAt"])
    .index("by_kind_year", ["kind", "year"])
    .index("by_sort", ["sortKey"])
    .index("by_added", ["addedAt"])
    .index("by_year", ["year"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["kind"] }),

  /**
   * One row per title and genre, so browsing a genre reads only its titles: Convex cannot index
   * array members. Rows copy the title's sort fields; `lib/genres.ts` keeps them in step with
   * every write of a title's genres or sort fields.
   */
  titleGenres: defineTable({
    titleId: v.id("titles"),
    libraryId: v.id("libraries"),
    /** The genre, trimmed and lowercased. */
    genre: v.string(),
    kind: titleKind,
    sortKey: v.string(),
    addedAt: v.number(),
    year: nullable(v.number()),
  })
    .index("by_title", ["titleId"])
    .index("by_genre_sort", ["genre", "sortKey"])
    .index("by_genre_added", ["genre", "addedAt"])
    .index("by_genre_year", ["genre", "year"])
    .index("by_kind_genre_sort", ["kind", "genre", "sortKey"])
    .index("by_kind_genre_added", ["kind", "genre", "addedAt"])
    .index("by_kind_genre_year", ["kind", "genre", "year"])
    .index("by_library_genre_sort", ["libraryId", "genre", "sortKey"])
    .index("by_library_genre_added", ["libraryId", "genre", "addedAt"])
    .index("by_library_genre_year", ["libraryId", "genre", "year"]),

  seasons: defineTable({
    titleId: v.id("titles"),
    seasonNumber: v.number(),
    name: v.string(),
    poster: nullable(v.string()),
    episodeCount: v.number(),
    externalIds: v.optional(externalIds),
  }).index("by_title_number", ["titleId", "seasonNumber"]),

  episodes: defineTable({
    titleId: v.id("titles"),
    seasonId: v.id("seasons"),
    seasonNumber: v.number(),
    episodeNumber: v.number(),
    name: v.string(),
    overview: nullable(v.string()),
    airDate: nullable(v.string()),
    runtimeMs: nullable(v.number()),
    still: nullable(v.string()),
    presentFileCount: v.number(),
    rating: v.optional(nullable(communityRating)),
    externalIds: v.optional(externalIds),
    /** Digest of the episode's guest stars and crew, so unchanged rescans skip rewriting them. */
    creditsHash: v.optional(v.string()),
  }).index("by_title_order", ["titleId", "seasonNumber", "episodeNumber"]),

  /**
   * Cast and crew. A person is identified by `personKey`: `tmdb:<id>` when TMDB knows them, else
   * `imdb:<id>`, else `name:<normalized name>` for people only an NFO names. A name-keyed person
   * is upgraded in place once a TMDB ID turns up, so their credits keep pointing at one row.
   */
  people: defineTable({
    personKey: v.string(),
    name: v.string(),
    sortKey: v.string(),
    externalIds,
    /** Photo artwork key. */
    profile: nullable(v.string()),
    biography: nullable(v.string()),
    birthDate: nullable(v.string()),
    deathDate: nullable(v.string()),
    birthPlace: nullable(v.string()),
    knownFor: nullable(v.string()),
    /** When a person or metadata job last wrote their details; null until then. */
    detailsFetchedAt: nullable(v.number()),
    /** When someone last asked for the details, so a page opened twice queues one job. */
    detailsRequestedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_key", ["personKey"])
    .index("by_name", ["name"])
    .index("by_tmdb", ["externalIds.tmdb"])
    .searchIndex("search_name", { searchField: "name" }),

  /** One person's credit on a title (`episodeId` null) or on one episode of a show. */
  credits: defineTable({
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    personId: v.id("people"),
    kind: creditKind,
    role: nullable(v.string()),
    order: v.number(),
  })
    .index("by_title_episode", ["titleId", "episodeId", "order"])
    .index("by_person", ["personId"]),

  mediaFiles: defineTable({
    libraryId: v.id("libraries"),
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    path: v.string(),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
    probe,
    externalSubtitles: v.array(externalSubtitle),
    versionName: nullable(v.string()),
    hdr: v.boolean(),
    missing: v.boolean(),
    missingSince: v.optional(v.number()),
    addedAt: v.number(),
    /** Scrub thumbnails; absent until a trickplay job is queued for this file. */
    trickplay: v.optional(trickplayState),
    /** Digest of the companions the scan read (NFO, artwork, subtitles), to notice their edits. */
    sidecarDigest: v.optional(nullable(v.string())),
  })
    .index("by_library_path", ["libraryId", "path"])
    .index("by_library_missing", ["libraryId", "missing"])
    .index("by_path", ["path"])
    .index("by_title", ["titleId"])
    .index("by_episode", ["episodeId"]),

  watchProgress: defineTable({
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    /** The episode for shows; null for movies. */
    episodeId: nullable(v.id("episodes")),
    fileId: nullable(v.id("mediaFiles")),
    positionMs: v.number(),
    durationMs: v.number(),
    watched: v.boolean(),
    updatedAt: v.number(),
    lastPlayedAt: v.number(),
    /** Completed plays; imported from Jellyfin or Plex, absent for items never imported. */
    playCount: v.optional(v.number()),
    /** The playback session that owns this progress; older sessions cannot overwrite it. */
    sessionId: v.optional(v.id("playbackSessions")),
    sessionStartedAt: v.optional(v.number()),
  })
    .index("by_profile_item", ["profileId", "titleId", "episodeId"])
    .index("by_profile_played", ["profileId", "lastPlayedAt"]),

  myList: defineTable({
    profileId: v.id("profiles"),
    titleId: v.id("titles"),
    addedAt: v.number(),
  })
    .index("by_profile_added", ["profileId", "addedAt"])
    .index("by_profile_title", ["profileId", "titleId"]),

  playbackSessions: defineTable({
    userId: v.id("users"),
    profileId: v.id("profiles"),
    /** The sign-in that started it; ending that sign-in ends this session. */
    authSessionId: v.id("authSessions"),
    deviceId: v.string(),
    deviceName: nullable(v.string()),
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    fileId: v.id("mediaFiles"),
    roomId: nullable(v.id("rooms")),
    mode: nullable(playbackMode),
    status: playbackSessionStatus,
    state: playbackState,
    positionMs: v.number(),
    startedAt: v.number(),
    lastReportAt: v.number(),
    endedAt: nullable(v.number()),
    /**
     * `download` for a file the device keeps: it reports no progress, and neither ends nor is ended
     * by the device's playback. Absent for playback.
     */
    purpose: v.optional(v.literal("download")),
  })
    .index("by_status_report", ["status", "lastReportAt"])
    .index("by_user_status", ["userId", "status"])
    .index("by_auth_session", ["authSessionId"])
    .index("by_title_status", ["titleId", "status"]),

  rooms: defineTable({
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    fileId: v.id("mediaFiles"),
    hostUserId: v.id("users"),
    hostProfileId: v.id("profiles"),
    hostDeviceId: v.string(),
    status: roomStatus,
    positionAtAnchorMs: v.number(),
    anchorServerTime: v.number(),
    playbackRate: v.number(),
    revision: v.number(),
    hostLastSeenAt: v.number(),
    hostAway: v.boolean(),
    /** The length of `fileId`, for an away host's end-of-file pause; absent on older rooms. */
    fileDurationMs: v.optional(v.number()),
    /**
     * The next-episode countdown for what the room plays now: pending until `nextAt`, when a
     * scheduled `rooms.nextEpisodeDue` moves the room on, or cancelled by the host. Absent when
     * there is none; every change of media clears it.
     */
    next: v.optional(storedRoomNext),
    endedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_title_status", ["titleId", "status"]),

  roomMembers: defineTable({
    roomId: v.id("rooms"),
    userId: v.id("users"),
    profileId: v.id("profiles"),
    deviceId: v.string(),
    role: roomRole,
    joinedAt: v.number(),
    lastSeenAt: v.number(),
    /** What the device's last heartbeat said it is doing; absent on rows from before it was kept. */
    presence: v.optional(roomPresence),
    /** When the device's player last reported: joining, or a watching heartbeat. */
    watchedAt: v.optional(v.number()),
    /** A guest's last reported distance from the shared position; absent until it reports one. */
    driftMs: v.optional(v.number()),
  })
    .index("by_room_device", ["roomId", "deviceId"])
    .index("by_user_device", ["userId", "deviceId"]),

  jobs: defineTable({
    kind: jobKind,
    status: jobStatus,
    payload: jobPayload,
    progress: jobProgress,
    error: nullable(v.string()),
    requestedBy: nullable(v.id("users")),
    attempts: v.number(),
    leaseOwner: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    startedAt: nullable(v.number()),
    finishedAt: nullable(v.number()),
    /** For scan jobs, the library, so a library shows whether it is scanning. */
    libraryId: v.optional(v.id("libraries")),
    /** For trickplay jobs, the file. */
    fileId: v.optional(v.id("mediaFiles")),
  })
    .index("by_status", ["status"])
    .index("by_kind_status", ["kind", "status"])
    .index("by_library_status", ["libraryId", "status"])
    .index("by_library", ["libraryId"]),

  /** A migration job's plan, checkpoint, and counts; one row per migration job. */
  migrations: defineTable({
    jobId: v.id("jobs"),
    source: migrationSource,
    serverId: v.string(),
    serverName: v.string(),
    plan: storedMigrationPlan,
    checkpoint: migrationCheckpoint,
    imported: migrationImported,
    libraryIds: v.array(v.id("libraries")),
  })
    .index("by_job", ["jobId"])
    .index("by_server", ["serverId"]),

  /** Named sets of titles: TMDB collections, NFO sets, and box sets imported from elsewhere. */
  collections: defineTable({
    name: v.string(),
    sortKey: v.string(),
    /**
     * Identifies a collection across runs: `jellyfin:<server>:<id>` or `plex:…` when imported,
     * `tmdb:<id>` for a TMDB collection, `set:<name>` for an NFO set.
     */
    sourceKey: nullable(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    overview: v.optional(nullable(v.string())),
    poster: v.optional(nullable(v.string())),
    backdrop: v.optional(nullable(v.string())),
  })
    .index("by_source_key", ["sourceKey"])
    .index("by_sort", ["sortKey"]),

  collectionItems: defineTable({
    collectionId: v.id("collections"),
    titleId: v.id("titles"),
    position: v.number(),
    /** `metadata` members come from a title's metadata; imports leave them alone. */
    source: v.optional(v.literal("metadata")),
  })
    .index("by_collection_position", ["collectionId", "position"])
    .index("by_title", ["titleId"]),

  backups: defineTable({
    fileName: v.string(),
    sizeBytes: v.number(),
    trigger: backupTrigger,
    jobId: v.optional(v.id("jobs")),
    /** When the archive was taken; rows written by `recordBackup` use their creation time. */
    takenAt: v.optional(v.number()),
  }),
});
