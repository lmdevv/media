import { v } from "convex/values";

import { internalMutation } from "../_generated/server";

/** PROTOTYPE B: creates a core user from a username sign-up. */
export const createFromUsername = internalMutation({
  args: { username: v.string(), usernameKey: v.string() },
  returns: v.id("users"),
  handler: (ctx, { username, usernameKey }) =>
    ctx.db.insert("users", { username, usernameKey, role: "member" }),
});
