import { v } from "convex/values";

import { internalQuery } from "./_generated/server";

/**
 * Parses password sign-in params with `v` validators and returns them typed. The `password`
 * provider calls it with the raw params the client sent; unknown fields or wrong types fail the
 * sign-in.
 */
export const password = internalQuery({
  args: {
    flow: v.union(v.literal("signUp"), v.literal("signIn")),
    email: v.string(),
    password: v.string(),
    name: v.optional(v.string()),
    inviteCode: v.optional(v.string()),
  },
  returns: v.object({
    flow: v.union(v.literal("signUp"), v.literal("signIn")),
    email: v.string(),
    password: v.string(),
    name: v.optional(v.string()),
    inviteCode: v.optional(v.string()),
  }),
  handler: (_ctx, args) => args,
});

/** PROTOTYPE A: parses the core username provider's params. */
export const username = internalQuery({
  args: {
    flow: v.union(v.literal("signUp"), v.literal("signIn")),
    username: v.string(),
    password: v.string(),
  },
  returns: v.object({
    flow: v.union(v.literal("signUp"), v.literal("signIn")),
    username: v.string(),
    password: v.string(),
  }),
  handler: (_ctx, args) => args,
});
