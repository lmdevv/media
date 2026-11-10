import { getAuthSessionId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { endSession } from "../sessions";

/**
 * How long after its first use a refresh token still refreshes, as Convex Auth's
 * `REFRESH_TOKEN_REUSE_WINDOW_MS`, which the package does not export.
 */
export const REUSE_WINDOW_MS = 10 * 1000;

/** Divides a refresh token's id from its session's, as Convex Auth's `REFRESH_TOKEN_DIVIDER`. */
export const DIVIDER = "|";

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

/** Reads and marks one call of an invalidation makes, inside Convex's 4,096 reads a call. */
const MARKS_PER_CALL = 256;

type Token = Doc<"authRefreshTokens">;

const frame = v.object({
  parent: v.id("authRefreshTokens"),
  after: v.union(v.number(), v.null()),
  skip: v.union(v.id("authRefreshTokens"), v.null()),
});

/** Children of `parent` still to mark: those created at or after `after`, past `skip`. */
type Frame = Infer<typeof frame>;

const tokens = (db: MutationCtx["db"]) => db.query("authRefreshTokens");

/**
 * The token Convex Auth calls active: the session's newest unused one, which the library finds by
 * scanning the session's tokens from the newest down. `by_session_use` holds the unused ones
 * together, so the store reads it at once, or null when the session has none.
 */
const activeToken = (db: MutationCtx["db"], sessionId: Id<"authSessions">): Promise<Token | null> =>
  tokens(db)
    .withIndex("by_session_use", (q) => q.eq("sessionId", sessionId).eq("firstUsedTime", undefined))
    .order("desc")
    .first();

/**
 * Marks the tokens under the top frame used, as of `marked`, depth first, until `budget` reads and
 * marks are spent, and answers the frames left. A token used since `marked` is marked too.
 */
const markFrom = async (
  ctx: Pick<MutationCtx, "db">,
  sessionId: Id<"authSessions">,
  frames: ReadonlyArray<Frame>,
  budget: number,
  marked: number,
): Promise<ReadonlyArray<Frame>> => {
  const top = frames.at(-1);
  const limit = budget - 1;

  if (top === undefined || limit < 1) return frames;

  const rows = (
    await tokens(ctx.db)
      .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
        q
          .eq("sessionId", sessionId)
          .eq("parentRefreshTokenId", top.parent)
          .gte("_creationTime", top.after ?? 0),
      )
      .take(limit + 2)
  ).filter((row) => row._id !== top.skip);

  const taken = rows.slice(0, limit);

  await Promise.all(
    taken
      .filter((row) => row.firstUsedTime === undefined || row.firstUsedTime > marked)
      .map((row) => ctx.db.patch(row._id, { firstUsedTime: marked })),
  );

  const last = taken.at(-1);

  const resumed =
    rows.length > limit && last !== undefined
      ? [{ parent: top.parent, after: last._creationTime, skip: last._id }]
      : [];

  const children = taken.map((row) => ({ parent: row._id, after: null, skip: null }));

  return markFrom(
    ctx,
    sessionId,
    [...frames.slice(0, -1), ...resumed, ...children],
    limit - taken.length,
    marked,
  );
};

const invalidate = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  sessionId: Id<"authSessions">,
  frames: ReadonlyArray<Frame>,
  marked: number,
): Promise<void> => {
  const left = await markFrom(ctx, sessionId, frames, MARKS_PER_CALL, marked);

  if (left.length > 0) {
    await ctx.scheduler.runAfter(0, internal.core.auth.store.invalidateTokens, {
      sessionId,
      frames: [...left],
      marked,
    });
  }
};

/** The tokens under a reused one still to mark, past the batch the refresh marked. */
export const invalidateTokens = internalMutation({
  args: { sessionId: v.id("authSessions"), frames: v.array(frame), marked: v.number() },
  returns: v.null(),
  handler: async (ctx, { sessionId, frames, marked }) => {
    if ((await ctx.db.get(sessionId)) !== null) await invalidate(ctx, sessionId, frames, marked);

    return null;
  },
});

/** What the store does with a refresh: answers it with null, or hands it to the library. */
export type Refresh = "answered" | "library";

/**
 * Decides a refresh before Convex Auth sees it, answering the cases where the library would read
 * every token of a session; the rest go on to the library.
 *
 * - A token that is gone or names another session refreshes nothing and ends nothing: it proves
 *   no hold on the session it names. The library would end that session.
 * - An expired token, or one whose session is gone or expired, ends its session through
 *   `endSession`, which does nothing once the session is gone. The library deletes every token in
 *   one call.
 * - A used token is answered by the library's rule. The library hands back the active token when
 *   the reused token is its parent, and inside the reuse window it mints the reused token a child;
 *   both go on to the library. Past the window it refreshes nothing and marks every token
 *   descended from the reused one used, in one call; the store marks them `MARKS_PER_CALL` a call,
 *   and the session and its other branches go on.
 */
export const decideRefresh = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  refreshToken: string,
): Promise<Refresh> => {
  const ids = idsOf(ctx, refreshToken);

  if (ids === null) return "library";

  const token = await ctx.db.get(ids.tokenId);

  if (token === null || token.sessionId !== ids.sessionId) return "answered";

  const now = Date.now();
  const session = await ctx.db.get(token.sessionId);

  if (token.expirationTime < now || session === null || session.expirationTime < now) {
    await endSession(ctx, token.sessionId);

    return "answered";
  }

  if (token.firstUsedTime === undefined || token.firstUsedTime + REUSE_WINDOW_MS > now) {
    return "library";
  }

  const active = await activeToken(ctx.db, token.sessionId);

  if (active?.parentRefreshTokenId === token._id) return "library";

  await invalidate(
    ctx,
    token.sessionId,
    [{ parent: token._id, after: null, skip: null }],
    now - REUSE_WINDOW_MS,
  );

  return "answered";
};
