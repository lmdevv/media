import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Deletes an auth session and its refresh tokens, as Convex Auth's sign-out does. Tokens already
 * issued for it stop working at once, because `loadViewer` requires the session to exist.
 */
export const endSession = async (
  ctx: MutationCtx,
  sessionId: Id<"authSessions">,
): Promise<void> => {
  const refreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();

  await Promise.all(refreshTokens.map((token) => ctx.db.delete(token._id)));

  if ((await ctx.db.get(sessionId)) !== null) await ctx.db.delete(sessionId);
};
