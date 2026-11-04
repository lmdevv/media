import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { assignableRole, credentialScope, role } from "../commands/scopes";
import { importSource } from "./core/jobs/kinds";
import { jobDocument, jobItemDocument, jobKindDocument } from "./core/jobs/model";

const sessionFields = {
  userId: v.id("users"),
  expirationTime: v.number(),
  /**
   * The user's `sessionGeneration`, or `keyGeneration` for an API key, when the session opened.
   * Required, so Convex Auth cannot open a session by itself.
   */
  generation: v.number(),
};

const deviceCodeFields = {
  /** SHA-256 of the secret half of the device code, hex. */
  secretHash: v.string(),
  /** Eight consonants as `XXXX-XXXX`, what the person types on the approving device. */
  userCode: v.string(),
  clientName: v.string(),
  expiresAt: v.number(),
};

/**
 * The core's tables. On the paths the core uses, Convex Auth touches only `users`, `authSessions`,
 * and `authRefreshTokens`, so its other tables are left out.
 */
export default defineSchema({
  users: defineTable({
    username: v.string(),
    /** The username folded for uniqueness and sign-in: `alice`. */
    usernameKey: v.string(),
    /** Exactly one user is the owner once the server is set up. */
    role,
    /** Bumped when every password and device session of the user ends. */
    sessionGeneration: v.number(),
    /** Bumped when every API key of the user ends. */
    keyGeneration: v.number(),
  })
    .index("by_username_key", ["usernameKey"])
    .index("by_role", ["role"]),

  authSessions: defineTable(
    v.union(
      v.object({ ...sessionFields, kind: v.literal("password") }),
      v.object({
        ...sessionFields,
        kind: v.literal("apiKey"),
        keyId: v.id("apiKeys"),
        scopes: v.array(credentialScope),
      }),
      v.object({
        ...sessionFields,
        kind: v.literal("deviceCode"),
        scopes: v.array(credentialScope),
        clientName: v.string(),
      }),
    ),
  )
    .index("userId", ["userId"])
    .index("by_key", ["keyId"])
    .index("by_expiration", ["expirationTime"]),

  /** Convex Auth's refresh tokens, in its own shape. */
  authRefreshTokens: defineTable({
    sessionId: v.id("authSessions"),
    expirationTime: v.number(),
    firstUsedTime: v.optional(v.number()),
    parentRefreshTokenId: v.optional(v.id("authRefreshTokens")),
  })
    .index("sessionId", ["sessionId"])
    .index("sessionIdAndParentRefreshTokenId", ["sessionId", "parentRefreshTokenId"])
    .index("by_expiration", ["expirationTime"]),

  /** A user's password, as a Scrypt hash. */
  passwords: defineTable({ userId: v.id("users"), hash: v.string() }).index("by_user", ["userId"]),

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
    scopes: v.array(credentialScope),
    /** The user's `keyGeneration` when the key was made. */
    generation: v.number(),
    expiresAt: v.optional(v.number()),
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

  /** An open invite. Accepting or revoking it deletes the row. */
  invites: defineTable({
    /** SHA-256 of the secret half of the invite code, hex. */
    secretHash: v.string(),
    role: assignableRole,
    invitedBy: v.id("users"),
    expiresAt: v.number(),
  }).index("by_expiration", ["expiresAt"]),

  /** A one-time password reset link. Using it deletes the row. */
  resetLinks: defineTable({
    /** SHA-256 of the secret half of the link code, hex. */
    secretHash: v.string(),
    userId: v.id("users"),
    madeBy: v.id("users"),
    /** The user's `sessionGeneration` when the link was made; ending their sessions voids it. */
    generation: v.number(),
    expiresAt: v.number(),
  }).index("by_expiration", ["expiresAt"]),

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
    .index("by_status", ["status"])
    .index("by_status_lease", ["status", "leaseExpiresAt"])
    .index("by_kind", ["payload.kind"])
    .index("by_dedupe_status", ["dedupeKey", "status"]),

  jobItems: defineTable(jobItemDocument).index("by_job_seq", ["jobId", "seq"]),

  jobKinds: defineTable(jobKindDocument).index("by_kind", ["kind"]),

  schemaMigrations: defineTable({
    name: v.string(),
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }).index("by_name", ["name"]),

  imports: defineTable({
    source: importSource,
    serverId: v.string(),
    serverName: v.string(),
    jobId: v.id("jobs"),
  })
    .index("by_job", ["jobId"])
    .index("by_source_server", ["source", "serverId"]),
});
