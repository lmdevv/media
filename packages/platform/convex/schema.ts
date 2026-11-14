import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { downloadItem, level, resourceId, resourceType, restrictions } from "../commands/access";
import { assignableRole, contentDomain, credentialScope, keyScope } from "../commands/scopes";
import { deviceSettingFields, downloadQuality, userSettingFields } from "../commands/settings";
import { guestAccessDocument, linkDocument } from "./core/guests/model";
import { importSource } from "./core/jobs/kinds";
import { jobDocument, jobItemDocument, jobKindDocument } from "./core/jobs/model";
import { moviesTables } from "./movies/schema";
import { musicTables } from "./music/schema";
import {
  beatDocument,
  entryDocument,
  memberDocument,
  sessionDocument,
} from "./core/together/model";

const sessionFields = {
  userId: v.id("users"),
  expirationTime: v.number(),
  /**
   * The user's `sessionGeneration`, or `keyGeneration` for an API key, when the session opened.
   * Required, so Convex Auth cannot open a session by itself.
   */
  generation: v.number(),
};

const boundDevice = v.object({
  id: v.id("devices"),
  generation: v.number(),
  /**
   * The session's number in the order sessions took the device: joined a personal device, or took
   * a shared device's tile. A later one ends this session there, so a client keeps the highest.
   * Absent on a session bound before the count began.
   */
  joined: v.optional(v.number()),
});

const generations = {
  /** Bumped when every password and device session of the user ends. */
  sessionGeneration: v.number(),
  /** Bumped when every API key of the user ends. */
  keyGeneration: v.number(),
};

const personFields = {
  kind: v.literal("person"),
  username: v.string(),
  /** The username folded for uniqueness and sign-in: `alice`. */
  usernameKey: v.string(),
  /** The name the person goes by in greetings and lists; absent, they go by their username. */
  displayName: v.optional(v.string()),
  ...generations,
  /** Listed on every shared device's picker (ADR 0006). An adult opts in; an admin lists a kid. */
  sharedDevices: v.optional(v.literal(true)),
  /** An admin requires this person's tile on shared devices to open with a proof. */
  tileLock: v.optional(v.literal(true)),
};

const deviceCodeFields = {
  /** SHA-256 of the secret half of the device code, hex. */
  secretHash: v.string(),
  /** Eight consonants as `XXXX-XXXX`, what the person types on the approving device. */
  userCode: v.string(),
  clientName: v.string(),
  expiresAt: v.number(),
};

const deviceFields = {
  name: v.string(),
  /** SHA-256 of the secret half of the device code, hex. */
  secretHash: v.string(),
  /** Bumped by every mode change; a session bound at another generation has ended. */
  generation: v.number(),
  /**
   * Sessions that have joined this device so far, absent before the first. Each join takes the
   * next number and ends the person's earlier session here, so a client keeps the highest.
   */
  joins: v.optional(v.number()),
};

const approvalFields = {
  deviceId: v.id("devices"),
  intent: v.union(v.literal("open"), v.literal("leave")),
  /** `open`: whose tile. `leave`: the kid who holds the device. */
  userId: v.id("users"),
  expiresAt: v.number(),
};

const connectOutput = v.union(
  v.object({ kind: v.literal("local") }),
  v.object({ kind: v.literal("cast"), receiver: v.union(v.string(), v.null()) }),
  v.object({ kind: v.literal("airplay"), receiver: v.union(v.string(), v.null()) }),
);

/**
 * The core's tables. On the paths the core uses, Convex Auth touches only `users`, `authSessions`,
 * and `authRefreshTokens`, so its other tables are left out.
 */
export default defineSchema({
  ...moviesTables,
  ...musicTables,

  /**
   * The principals. A person has a role, and exactly one person is the owner once the server is
   * set up; only a member carries restrictions, which make them a kid. A service, such as the
   * media server, has no role, password, or restrictions.
   */
  users: defineTable(
    v.union(
      v.object({
        ...personFields,
        role: v.literal("member"),
        restrictions: v.optional(restrictions),
        /**
         * An admin let this member make guest links (ADR 0007). Owners and admins always may, so a
         * promotion clears it.
         */
        sharesWithGuests: v.optional(v.literal(true)),
      }),
      v.object({ ...personFields, role: v.union(v.literal("owner"), v.literal("admin")) }),
      /**
       * A guest a share link let in. `username` is the name they typed, not unique; `usernameKey`
       * is `~<linkId>.<n>`, outside the username grammar, so no sign-in ever finds it.
       */
      v.object({ ...personFields, role: v.literal("guest"), link: v.id("shareLinks") }),
      v.object({ kind: v.literal("service"), name: v.string(), ...generations }),
    ),
  )
    .index("by_username_key", ["usernameKey"])
    .index("by_role", ["role"])
    .index("by_kind_username_key", ["kind", "usernameKey"])
    .index("by_shared_devices", ["sharedDevices", "usernameKey"])
    .index("by_link", ["link"]),

  authSessions: defineTable(
    v.union(
      v.object({
        ...sessionFields,
        kind: v.literal("password"),
        device: v.optional(boundDevice),
        /** The device grant this session issued or took up; revoking the grant ends it. */
        grant: v.optional(v.id("deviceGrants")),
      }),
      v.object({
        ...sessionFields,
        kind: v.literal("apiKey"),
        keyId: v.id("apiKeys"),
        scopes: v.array(keyScope),
      }),
      v.object({
        ...sessionFields,
        kind: v.literal("deviceCode"),
        scopes: v.array(credentialScope),
        clientName: v.string(),
        device: v.optional(boundDevice),
      }),
      /** A tile opened on a shared device. Its scopes are its person's content scopes, never stored. */
      v.object({ ...sessionFields, kind: v.literal("tile"), device: boundDevice }),
      /** A guest's, opened by a share link; it ends no later than the link and only while it holds. */
      v.object({ ...sessionFields, kind: v.literal("guest") }),
      /**
       * An app's own session, exchanged for its device's grant (D48). It holds its person's role
       * scopes, as a password session does, and ends with the grant.
       */
      v.object({
        ...sessionFields,
        kind: v.literal("grant"),
        grant: v.id("deviceGrants"),
        device: v.optional(boundDevice),
      }),
    ),
  )
    .index("userId", ["userId"])
    .index("by_key", ["keyId"])
    .index("by_expiration", ["expirationTime"])
    .index("by_device_user", ["device.id", "userId"])
    .index("by_user_device", ["userId", "device.id"])
    .index("by_grant", ["grant"]),

  /**
   * Convex Auth's refresh tokens, in its own shape. `by_session_use` finds a session's active token,
   * its newest unused one, in one read (`core/auth/store.ts`).
   */
  authRefreshTokens: defineTable({
    sessionId: v.id("authSessions"),
    expirationTime: v.number(),
    firstUsedTime: v.optional(v.number()),
    parentRefreshTokenId: v.optional(v.id("authRefreshTokens")),
  })
    .index("sessionId", ["sessionId"])
    .index("sessionIdAndParentRefreshTokenId", ["sessionId", "parentRefreshTokenId"])
    .index("by_session_use", ["sessionId", "firstUsedTime"])
    .index("by_expiration", ["expirationTime"]),

  /** A user's password, as a Scrypt hash. */
  passwords: defineTable({ userId: v.id("users"), hash: v.string() }).index("by_user", ["userId"]),

  /**
   * The nonce of every sign-in pass the core took, with the provider and address digest it was
   * signed for, until a minute after the pass expires, so each pass signs in once
   * (`core/auth/passes.ts`, ADR 0007).
   */
  signInPasses: defineTable({
    nonce: v.string(),
    expiresAt: v.number(),
    provider: v.string(),
    addressDigest: v.string(),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expiration", ["expiresAt"]),

  rateLimits: defineTable({
    identifier: v.string(),
    attemptsLeft: v.number(),
    lastAttemptTime: v.number(),
  })
    .index("by_identifier", ["identifier"])
    .index("by_last_attempt", ["lastAttemptTime"]),

  apiKeys: defineTable({
    userId: v.id("users"),
    name: v.string(),
    secretHash: v.string(),
    scopes: v.array(keyScope),
    /** The user's `keyGeneration` when the key was made. */
    generation: v.number(),
    expiresAt: v.optional(v.number()),
    /** When the key last signed in; absent until it first does. */
    lastUsedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  deviceCodes: defineTable(
    v.union(
      v.object({ ...deviceCodeFields, state: v.literal("pending") }),
      v.object({
        ...deviceCodeFields,
        state: v.literal("approved"),
        approvedBy: v.id("users"),
        scopes: v.array(credentialScope),
        /** The approver's `sessionGeneration` at approval. */
        generation: v.number(),
      }),
      v.object({ ...deviceCodeFields, state: v.literal("denied") }),
      /** Redeemed: the device gets this session again until the code expires. */
      v.object({
        ...deviceCodeFields,
        state: v.literal("redeemed"),
        approvedBy: v.id("users"),
        sessionId: v.id("authSessions"),
      }),
    ),
  )
    .index("by_user_code", ["userCode"])
    .index("by_expiration", ["expiresAt"]),

  invites: defineTable({
    /** SHA-256 of the secret half of the invite code, hex. */
    secretHash: v.string(),
    role: assignableRole,
    invitedBy: v.id("users"),
    inviterSessionGeneration: v.number(),
    expiresAt: v.number(),
  }).index("by_expiration", ["expiresAt"]),

  resetLinks: defineTable({
    /** SHA-256 of the secret half of the link code, hex. */
    secretHash: v.string(),
    userId: v.id("users"),
    madeBy: v.id("users"),
    userSessionGeneration: v.number(),
    makerSessionGeneration: v.number(),
    expiresAt: v.number(),
  }).index("by_expiration", ["expiresAt"]),

  /** One row per resource and principal. `core/permissions/grants.ts` is its only writer. */
  grants: defineTable({
    resourceType,
    resourceId,
    /** A user, a group, or the household, stored as one value so it indexes. */
    principal: v.union(v.id("users"), v.id("groups"), v.literal("household")),
    level,
  })
    .index("by_resource_principal", ["resourceType", "resourceId", "principal"])
    .index("by_principal_resource", ["principal", "resourceType", "resourceId"]),

  groups: defineTable({
    name: v.string(),
    /** The name folded for uniqueness and order. */
    nameKey: v.string(),
  }).index("by_name_key", ["nameKey"]),

  groupMembers: defineTable({ groupId: v.id("groups"), userId: v.id("users") })
    .index("by_group_user", ["groupId", "userId"])
    .index("by_user_group", ["userId", "groupId"]),

  /**
   * A person's grant on one phone or tablet (D48, ADR 0006). The device's shared keychain holds
   * `dg_<grantId>.<secret>`, and each app there exchanges it for a session of its own. Revoking it
   * ends every session it issued or minted.
   */
  deviceGrants: defineTable({
    userId: v.id("users"),
    name: v.string(),
    /** SHA-256 of the secret half of the grant, hex. The grant itself is never stored. */
    secretHash: v.string(),
    /**
     * The person's `sessionGeneration` when the grant was issued or last confirmed with a password.
     * Once they sign out everywhere it differs, and the grant mints nothing until a password
     * sign-in on the device confirms it again.
     */
    generation: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * One row per app instance (ADR 0006). A shared device's `tile` is the last tile opened on it and
   * its session, which stays live only while it fills the slot; a kid there holds the device.
   */
  devices: defineTable(
    v.union(
      v.object({ ...deviceFields, mode: v.literal("personal") }),
      v.object({
        ...deviceFields,
        mode: v.literal("shared"),
        tile: v.union(
          v.null(),
          v.object({ userId: v.id("users"), sessionId: v.id("authSessions") }),
        ),
      }),
    ),
  ).index("by_mode", ["mode"]),

  /**
   * What a device last said it plays, one row per device (ADR 0018). Only the device writes it,
   * through `core.connect.player.report` from a session bound to it, and it lives apart from
   * `devices`, whose row every authenticated call reads. `core/devices/registry.ts` deletes it
   * when the device changes mode or goes.
   */
  connectPlayers: defineTable({
    deviceId: v.id("devices"),
    /** The session that reported; the device is no target once that session ends. */
    reporter: v.id("authSessions"),
    output: connectOutput,
    /** Null while the device plays nothing. Its position held at `reportedAt`. */
    playback: v.union(
      v.null(),
      v.object({ domain: contentDomain, playing: v.boolean(), positionMs: v.number() }),
    ),
    settled: v.number(),
    /** Server time of the report. */
    reportedAt: v.number(),
  })
    .index("by_device", ["deviceId"])
    .index("by_reported", ["reportedAt"]),

  /**
   * The playback controllers last asked of a device, one row per device. Only
   * `core.connect.targets.control` writes it.
   */
  connectRequests: defineTable({
    deviceId: v.id("devices"),
    reporter: v.id("authSessions"),
    /** Higher than every revision before it on this device. */
    revision: v.number(),
    playing: v.boolean(),
    /** The position at `at`, server time; it moves on from there while `playing`. */
    positionMs: v.number(),
    at: v.number(),
  }).index("by_device", ["deviceId"]),

  /** A person's unlock code as a Scrypt hash. It opens their tile on a lock screen and never signs in. */
  unlockCodes: defineTable({ userId: v.id("users"), hash: v.string() }).index("by_user", [
    "userId",
  ]),

  /** Wrong unlock codes in a row for one person on one shared device, against one code. */
  unlockStrikes: defineTable({
    deviceId: v.id("devices"),
    userId: v.id("users"),
    codeId: v.id("unlockCodes"),
    wrong: v.number(),
  }).index("by_device_user", ["deviceId", "userId"]),

  /** An approval a shared device asked for; each device keeps at most one. */
  tileApprovals: defineTable(
    v.union(
      v.object({ ...approvalFields, state: v.literal("pending") }),
      v.object({ ...approvalFields, state: v.literal("denied"), answeredBy: v.id("users") }),
      v.object({
        ...approvalFields,
        state: v.literal("approved"),
        answeredBy: v.id("users"),
        /** The approver's `sessionGeneration` at approval; signing out everywhere voids it. */
        generation: v.number(),
      }),
      /** Opened: the device gets this session again until the approval expires. */
      v.object({
        ...approvalFields,
        state: v.literal("redeemed"),
        answeredBy: v.id("users"),
        sessionId: v.id("authSessions"),
      }),
    ),
  )
    .index("by_device", ["deviceId"])
    .index("by_user_intent_state_expiration", ["userId", "intent", "state", "expiresAt"])
    .index("by_intent_state_expiration", ["intent", "state", "expiresAt"])
    .index("by_expiration", ["expiresAt"]),

  /**
   * A person's settings that follow them to every device (ADR 0019): at most one row per person,
   * made by their first change. A missing field is that setting's default. `core/settings.ts` is
   * its only writer.
   */
  userSettings: defineTable({ userId: v.id("users"), ...userSettingFields }).index("by_user", [
    "userId",
  ]),

  /**
   * A person's own settings on one device: at most one row per device and person, deleted with
   * the device. A missing field is that setting's default. `core/settings.ts` is its only writer.
   */
  deviceSettings: defineTable({
    deviceId: v.id("devices"),
    userId: v.id("users"),
    ...deviceSettingFields,
  }).index("by_device_user", ["deviceId", "userId"]),

  /**
   * One item a person keeps on one device for offline play (ADR 0019). It holds no access state:
   * `can` decides on every read whether the item may still play there, so a revoked grant or a new
   * restriction expires it without a write here. Deleted by `remove`, or in pages once its device is
   * removed. `core/downloads.ts` is its only writer.
   */
  downloads: defineTable({
    deviceId: v.id("devices"),
    userId: v.id("users"),
    item: downloadItem,
    /** The person's `downloadQuality` on the device when they added it; it stays for the row. */
    quality: downloadQuality,
    /**
     * What the item takes against its device's download limit, as its domain estimated it for
     * `revision`. Fetching a newer revision estimates it again.
     */
    reserved: v.object({ bytes: v.number(), revision: v.string() }),
  })
    .index("by_device_user", ["deviceId", "userId"])
    .index("by_device_user_item", ["deviceId", "userId", "item.kind", "item.id"]),

  /**
   * An admin's limit on the bytes of downloads one device keeps for everyone on it. A device with
   * no row has the default. `core/downloads.ts` is its only writer.
   */
  downloadCaps: defineTable({ deviceId: v.id("devices"), bytes: v.number() }).index("by_device", [
    "deviceId",
  ]),

  /**
   * A library: a name and the domain its content belongs to. Its folders live in
   * `libraryFolders`, its item count in `counters`, and who sees it in `grants`.
   * `core/libraries.ts` is its only writer.
   */
  libraries: defineTable({
    name: v.string(),
    kind: contentDomain,
    /**
     * The newest scan job made for it, null before the first. That job's status, progress, and
     * end are the library's scan state.
     */
    lastScan: v.union(v.id("jobs"), v.null()),
    /**
     * A file changed while `lastScan` ran, after it may have passed the file's folder: once that
     * scan stops running, one more scan is queued (ADR 0024).
     */
    rescanAfter: v.optional(v.literal(true)),
  }).index("by_kind", ["kind"]),

  /**
   * One row per folder of a library, as `core/folders.ts` writes it down, and the only copy of a
   * library's folders. `by_path` finds a taken folder, one that holds a folder, or one inside it
   * with point reads and one range, however many libraries exist.
   */
  libraryFolders: defineTable({ libraryId: v.id("libraries"), path: v.string() })
    .index("by_path", ["path"])
    .index("by_library_path", ["libraryId", "path"]),

  /**
   * A library's claim of one of its folders by what it is on disk (ADR 0024, "Folder identity"):
   * at most one per library and folder, its keys in `folderClaimKeys`. The claim that came first
   * keeps a folder two libraries reach. `core/folderClaims.ts` is its only writer.
   */
  folderClaims: defineTable({
    libraryId: v.id("libraries"),
    folder: v.string(),
    /** When the library first claimed the folder; every later claim of it keeps this. */
    since: v.number(),
    /** The host's boot id at the latest claim, for diagnosis only; null when the server could not tell. */
    bootId: v.union(v.string(), v.null()),
    /**
     * Whether an older claim of another library took the folder: the claim then has no keys, the
     * library's scans write nothing, and its purge deletes its rows there until it claims again.
     */
    lost: v.boolean(),
  }).index("by_library_folder", ["libraryId", "folder"]),

  /**
   * One key of a folder claim: an `i:<dev>:<ino>` identity of the folder (depth 0) or of a parent
   * (its depth), or its source path within its filesystem, `s:<device>:/<part hash>/…/` at depth 0.
   * Another library's identity row with this folder's own identity holds a folder at or inside
   * it, and a source key that starts with this folder's is a source at or inside it; a row at
   * depth 0 with a parent's identity or source key is a folder around it.
   */
  folderClaimKeys: defineTable({
    claimId: v.id("folderClaims"),
    libraryId: v.id("libraries"),
    /** The claim's `since`, so an overlap read compares claims without reading them. */
    since: v.number(),
    key: v.string(),
    depth: v.number(),
  })
    .index("by_key_depth", ["key", "depth"])
    .index("by_claim", ["claimId"]),

  /**
   * A library refused a folder because `ownerLibraryId`'s claim came first. When the owner lets a
   * claim go, `core/libraries.ts` queues a scan of each waiting library and the row goes.
   */
  folderClaimWaits: defineTable({
    libraryId: v.id("libraries"),
    ownerLibraryId: v.id("libraries"),
  })
    .index("by_owner_library", ["ownerLibraryId", "libraryId"])
    .index("by_library", ["libraryId"]),

  counters: defineTable({
    name: v.string(),
    shard: v.number(),
    value: v.number(),
  }).index("by_name_shard", ["name", "shard"]),

  limitsProbeRows: defineTable({
    group: v.string(),
    position: v.number(),
    doubled: v.optional(v.number()),
  }).index("by_group_position", ["group", "position"]),

  jobs: defineTable(jobDocument)
    .index("by_kind_status", ["payload.kind", "status"])
    /** A kind's queued jobs a claim may take now, which have no `waitUntil`, oldest first. */
    .index("by_kind_ready", ["payload.kind", "status", "waitUntil"])
    /** Queued jobs waiting for a retry's time, for `core/jobs/leases:wakeDue`. */
    .index("by_status_wait", ["status", "waitUntil"])
    .index("by_status", ["status"])
    .index("by_status_lease", ["status", "leaseExpiresAt"])
    .index("by_kind", ["payload.kind"])
    .index("by_dedupe_status", ["dedupeKey", "status"])
    /** A track's `music.lyrics` jobs by status, for the music purge; no other kind has the field. */
    .index("by_track_status", ["payload.trackId", "status"])
    /** The finished jobs of one kind and status by age, for `core/jobs/cleanup.ts`. */
    .index("by_kind_status_finished", ["payload.kind", "status", "finishedAt"]),

  jobItems: defineTable(jobItemDocument).index("by_job_seq", ["jobId", "seq"]),

  jobKinds: defineTable(jobKindDocument)
    .index("by_kind", ["kind"])
    /** Paused kinds by when their pause ends, for `core/jobs/leases:wakeDue`. */
    .index("by_paused", ["pausedUntil"]),

  schemaMigrations: defineTable({
    name: v.string(),
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }).index("by_name", ["name"]),

  /**
   * A group session (ADR 0017), found by id from its link or from a member row.
   * `core/together/` is its only writer.
   */
  togetherSessions: defineTable(sessionDocument),

  togetherMembers: defineTable(memberDocument)
    .index("by_user_domain", ["userId", "domain"])
    .index("by_session_state", ["sessionId", "state"]),

  togetherBeats: defineTable(beatDocument)
    .index("by_member", ["memberId"])
    .index("by_session", ["sessionId"])
    .index("by_seen", ["seenAt"]),

  togetherEntries: defineTable(entryDocument)
    .index("by_session_order", ["sessionId", "order"])
    .index("by_session_item", ["sessionId", "item.ref.type", "item.ref.id"]),

  /** Share links that let guests in (ADR 0007). `core/guests/` is their only writer. */
  shareLinks: defineTable(linkDocument).index("by_maker", ["maker"]),

  guestAccess: defineTable(guestAccessDocument),

  /**
   * The archives in the server's backup folder (`convex export`), as it last reported them.
   * `core/backups.ts` is its only writer.
   */
  backups: defineTable({
    /** A plain file name in the backup folder, at most 255 characters. */
    fileName: v.string(),
    sizeBytes: v.number(),
    trigger: v.union(v.literal("nightly"), v.literal("manual")),
    takenAt: v.number(),
  })
    .index("by_taken", ["takenAt"])
    .index("by_file", ["fileName"]),

  /**
   * What each media server last said about itself, one row per service principal.
   * `core/serverStatus.ts` is its only writer.
   */
  serverStatus: defineTable({
    serviceId: v.id("users"),
    version: v.string(),
    hardwareAcceleration: v.union(v.literal("qsv"), v.literal("vaapi"), v.literal("none")),
    activeStreams: v.number(),
    runsAwaitingExit: v.number(),
    startedAt: v.number(),
    /** Server time of the report; clients judge staleness from it. */
    reportedAt: v.number(),
  })
    .index("by_service", ["serviceId"])
    .index("by_reported", ["reportedAt"]),

  imports: defineTable({
    source: importSource,
    serverId: v.string(),
    serverName: v.string(),
    jobId: v.id("jobs"),
  })
    .index("by_job", ["jobId"])
    .index("by_source_server", ["source", "serverId"]),
});
