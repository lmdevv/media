import { v } from "convex/values";

import { internalMutation } from "../_generated/server";

/** PROTOTYPE A: creates a core user from a username sign-up, with no invite check of movies'. */
export const createFromUsername = internalMutation({
  args: { username: v.string(), usernameKey: v.string() },
  returns: v.id("users"),
  handler: (ctx, { username, usernameKey }) =>
    ctx.db.insert("users", { username, usernameKey, role: "member" }),
});
