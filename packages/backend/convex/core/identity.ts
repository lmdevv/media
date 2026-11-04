import { defineTable } from "convex/server";
import { v } from "convex/values";

import { role, scope } from "../lib/validators";

/**
 * PROTOTYPE A1: the core identity tables are the one definition of Convex Auth's `users` and
 * `authSessions`. Old movies keeps running only because every movies-only field stays in the
 * core's definitions as a compatibility field until the movies port.
 */
export const identityTables = {
  users: defineTable({
    /** Core: username as typed (D13). Optional only because movies sign-ups have none. */
    username: v.optional(v.string()),
    /** Core: lowercased username, unique (D13). Optional for the same reason. */
    usernameKey: v.optional(v.string()),
    name: v.optional(v.string()),
    /** COMPAT: movies' role union keeps `service`, which D16 makes a separate principal type. */
    role,
    disabledAt: v.optional(v.number()),
    sessionsValidAfter: v.optional(v.number()),
    keysValidAfter: v.optional(v.number()),
    sessionGeneration: v.optional(v.number()),
    /** COMPAT: movies signs in by email; D13 collects none. */
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    inviteCode: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("by_username", ["usernameKey"])
    .index("by_role", ["role"]),

  authSessions: defineTable({
    userId: v.id("users"),
    expirationTime: v.number(),
    generation: v.optional(v.number()),
    /** COMPAT: movies' restricted-session grant. */
    grant: v.optional(
      v.object({
        kind: v.union(v.literal("apikey"), v.literal("device")),
        scopes: v.array(scope),
        label: v.string(),
        apiKeyId: v.optional(v.id("apiKeys")),
        deviceCodeId: v.optional(v.id("deviceCodes")),
      }),
    ),
    /** COMPAT: movies' PIN profile unlocks; D12 removes profiles. */
    unlockedProfiles: v.optional(v.array(v.id("profiles"))),
  }).index("userId", ["userId"]),
};
