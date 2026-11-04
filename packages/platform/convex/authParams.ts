import { v } from "convex/values";

import { internalQuery } from "./_generated/server";

const usernameParams = {
  flow: v.union(v.literal("signUp"), v.literal("signIn")),
  username: v.string(),
  password: v.string(),
};

/** PROTOTYPE B: parses the username provider's sign-in params with `v` validators. */
export const username = internalQuery({
  args: usernameParams,
  returns: v.object(usernameParams),
  handler: (_ctx, args) => args,
});
