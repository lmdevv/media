import { getAuthSessionId } from "@convex-dev/auth/server";
import { v } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { endSession } from "../sessions";

/**
 * How long after its first use a refresh token still refreshes, as Convex Auth's
 * `REFRESH_TOKEN_REUSE_WINDOW_MS`, which the package does not export.
 */
const REUSE_WINDOW_MS = 10 * 1000;

/** Divides a refresh token's id from its session's, as Convex Auth's `REFRESH_TOKEN_DIVIDER`. */
const DIVIDER = "|";

/**
 * The `auth:store` calls the core's sign-in flows make. Every provider is a credentials provider
 * that opens its own session (`core/sessions.ts`), so a sign-in always names one, and the email,
 * OAuth, and account calls are refused as arguments.
 */
export const storeCall = v.union(
  v.object({
    type: v.literal("signIn"),
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    generateTokens: v.boolean(),
  }),
  v.object({ type: v.literal("signOut") }),
  v.object({ type: v.literal("refreshSession"), refreshToken: v.string() }),
);

/**
 * `auth:signOut`: ends the caller's session the way `endSession` does, so its refresh tokens go a
 * batch per call. Convex Auth deletes them all in one call, which fails past Convex's read limit.
 */
export const signOutCaller = async (
  ctx: Pick<MutationCtx, "auth" | "db" | "scheduler">,
): Promise<{ readonly userId: Id<"users">; readonly sessionId: Id<"authSessions"> } | null> => {
  const sessionId = await getAuthSessionId(ctx);
  const session = sessionId === null ? null : await ctx.db.get(sessionId);

  if (session === null) return null;

  await endSession(ctx, session._id);

  return { userId: session.userId, sessionId: session._id };
};

const idsOf = (
  ctx: Pick<MutationCtx, "db">,
  refreshToken: string,
): { readonly tokenId: Id<"authRefreshTokens">; readonly sessionId: Id<"authSessions"> } | null => {
  const [token = "", session = ""] = refreshToken.split(DIVIDER);
  const tokenId = ctx.db.normalizeId("authRefreshTokens", token);
  const sessionId = ctx.db.normalizeId("authSessions", session);

  return tokenId === null || sessionId === null ? null : { tokenId, sessionId };
};

/**
 * Answers a refresh that Convex Auth would answer by reading every token of a session, and says
 * whether it did; the rest go on to the library.
 *
 * - A token that is gone or names another session refreshes nothing and ends nothing: it proves
 *   no hold on the session it names. The library would end that session.
 * - An expired token, or one whose session is gone or expired, ends its session the way
 *   `endSession` does. The library deletes every token in one call.
 * - A token used again past the reuse window, other than as the parent of the newest token, ends
 *   its session: it may have been stolen. The library walks and marks every token descended from
 *   it in one call, and the session it leaves can no longer refresh.
 *
 * Every refresh the library answers adds a token or hands back the newest one, so the newest token
 * is the one it calls active.
 */
export const answeredBeforeLibrary = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  refreshToken: string,
): Promise<boolean> => {
  const ids = idsOf(ctx, refreshToken);

  if (ids === null) return false;

  const token = await ctx.db.get(ids.tokenId);

  if (token === null || token.sessionId !== ids.sessionId) return true;

  const now = Date.now();
  const session = await ctx.db.get(token.sessionId);

  if (token.expirationTime < now || session === null || session.expirationTime < now) {
    await endSession(ctx, token.sessionId);

    return true;
  }

  if (token.firstUsedTime === undefined || token.firstUsedTime + REUSE_WINDOW_MS > now) {
    return false;
  }

  const newest = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", token.sessionId))
    .order("desc")
    .first();

  if (newest?.firstUsedTime === undefined && newest?.parentRefreshTokenId === token._id) {
    return false;
  }

  await endSession(ctx, token.sessionId);

  return true;
};
