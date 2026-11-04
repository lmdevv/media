import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import { query } from "../_generated/server";

/** PROTOTYPE B: the signed-in core user's username, or null. */
export const username = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);

    if (userId === null) return null;

    const user = await ctx.db.get(userId);

    return user?.username ?? null;
  },
});
