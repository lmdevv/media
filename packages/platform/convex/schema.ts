import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { credentialScope } from "../commands/scopes";
import { jobDocument, jobItemDocument } from "./core/jobs/model";

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
    /** Bumped when every password and device session of the user ends. */
    sessionGeneration: v.number(),
    /** Bumped when every API key of the user ends. */
    keyGeneration: v.number(),
  }).index("by_username_key", ["usernameKey"]),

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

  counters: defineTable({
    name: v.string(),
    shard: v.number(),
    value: v.number(),
  }).index("by_name_shard", ["name", "shard"]),

  limitsProbeRows: defineTable({
    group: v.string(),
    position: v.number(),
  }).index("by_group_position", ["group", "position"]),

  /**
   * Every background job of every domain (ADR 0012), one index per access pattern:
   *
   * - `by_kind_status`: a claim's queue head and cap read, and kind plus status lists.
   * - `by_status_lease`: the lease-release cron (running, earliest expiry first) and status lists.
   *   Only running rows carry `leaseExpiresAt`, so other statuses order by creation.
   * - `by_kind`: kind lists across statuses.
   * - `by_dedupe_status`: enqueue's check for a queued or running job with the same key.
   */
  jobs: defineTable(jobDocument)
    .index("by_kind_status", ["payload.kind", "status"])
    .index("by_status_lease", ["status", "leaseExpiresAt"])
    .index("by_kind", ["payload.kind"])
    .index("by_dedupe_status", ["dedupeKey", "status"]),

  /**
   * A job's batched items. Rows below the job's watermark are deleted as the holder reports them
   * done, and a finished job's leftovers are purged in batches (`leases.purgeItems`).
   */
  jobItems: defineTable(jobItemDocument).index("by_job_seq", ["jobId", "seq"]),
});
