import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * PROTOTYPE B: the core's own deployment. Convex Auth's fixed table names belong to the core
 * alone, so `users` and `authSessions` take the core shape with no movies fields.
 */
export default defineSchema({
  ...authTables,

  users: defineTable({
    username: v.string(),
    usernameKey: v.string(),
    name: v.optional(v.string()),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("guest")),
    disabledAt: v.optional(v.number()),
    sessionsValidAfter: v.optional(v.number()),
    keysValidAfter: v.optional(v.number()),
    sessionGeneration: v.optional(v.number()),
  }).index("by_username", ["usernameKey"]),

  authSessions: defineTable({
    userId: v.id("users"),
    expirationTime: v.number(),
    generation: v.optional(v.number()),
  }).index("userId", ["userId"]),

  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
});
