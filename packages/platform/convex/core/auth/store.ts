import { getAuthSessionId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import { endSession, SESSION_MS } from "../sessions";

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

/**
 * How deep the store follows Convex Auth's search for the active token, from the newest token down
 * to the first unused one. The library repeats that search when the store hands it a refresh, so
 * the two together stay inside one call's 4,096 reads.
 */
const ACTIVE_DEPTH = 1500;

/** Newest tokens read before the deeper search; the active token is the newest one but after an invalidation. */
const ACTIVE_NEAR = 8;

/** Children of a reused token read to find its newest unused one. */
const CHILDREN_READ = 64;

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

const unused = (token: Token): boolean => token.firstUsedTime === undefined;

/**
 * The token Convex Auth calls active: the session's newest unused one, found as the library finds
 * it, from the newest token down, or null when the session has none. "deep" when the newest
 * `ACTIVE_DEPTH` are all used, which only marked branches leave above it.
 */
const activeToken = async (
  db: MutationCtx["db"],
  sessionId: Id<"authSessions">,
): Promise<Token | null | "deep"> => {
  const newest = (count: number) =>
    tokens(db)
      .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(count);

  const near = await newest(ACTIVE_NEAR);
  const nearActive = near.find(unused);

  if (nearActive !== undefined) return nearActive;

  if (near.length < ACTIVE_NEAR) return null;

  const far = await newest(ACTIVE_DEPTH + 1);

  return far.find(unused) ?? (far.length > ACTIVE_DEPTH ? "deep" : null);
};

/**
 * Whether `token` has an unused child, read newest first through the parent index; "deep" when
 * its newest `CHILDREN_READ` children are all used.
 */
const hasUnusedChild = async (db: MutationCtx["db"], token: Token): Promise<boolean | "deep"> => {
  const children = await tokens(db)
    .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
      q.eq("sessionId", token.sessionId).eq("parentRefreshTokenId", token._id),
    )
    .order("desc")
    .take(CHILDREN_READ + 1);

  if (children.some(unused)) return true;

  return children.length > CHILDREN_READ ? "deep" : false;
};

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

/** What the store does with a refresh: answers it with null, or hands the library a token. */
export type Refresh =
  | { readonly kind: "answered" }
  | { readonly kind: "library"; readonly refreshToken: string };

const ANSWERED: Refresh = { kind: "answered" };

/**
 * Decides a refresh before Convex Auth sees it, answering the cases where the library would read
 * every token of a session; the rest go on to the library.
 *
 * - A token that is gone or names another session refreshes nothing and ends nothing: it proves
 *   no hold on the session it names. The library would end that session.
 * - An expired token, or one whose session is gone or expired, ends its session through
 *   `endSession`, which does nothing once the session is gone. The library deletes every token in
 *   one call.
 * - A used token is answered as the library answers it. The library hands back the active token
 *   when the reused token is its parent; otherwise, inside the reuse window, it mints a child of
 *   the reused token, and past it, it marks every token descended from the reused one used and
 *   refreshes nothing. The store marks them `MARKS_PER_CALL` a call, and the session and its other
 *   branches go on. A late retry of a token with no unused child is answered that way without the
 *   search for the active token, since no child can be it.
 * - When the active token lies below `ACTIVE_DEPTH` used ones, the library's own search would read
 *   them all. Wherever the library could return a token (inside the window, or past it when the
 *   reused token has an unused child), the store adds a fresh child of the reused token and hands
 *   the library that instead: on first use the library reads only the token and its session, and
 *   what it mints stays in the reused token's branch. Otherwise it marks the branch.
 */
export const decideRefresh = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  refreshToken: string,
): Promise<Refresh> => {
  const ids = idsOf(ctx, refreshToken);

  const library: Refresh = { kind: "library", refreshToken };

  if (ids === null) return library;

  const token = await ctx.db.get(ids.tokenId);

  if (token === null || token.sessionId !== ids.sessionId) return ANSWERED;

  const now = Date.now();
  const session = await ctx.db.get(token.sessionId);

  if (token.expirationTime < now || session === null || session.expirationTime < now) {
    await endSession(ctx, token.sessionId);

    return ANSWERED;
  }

  if (token.firstUsedTime === undefined) return library;

  const inWindow = token.firstUsedTime + REUSE_WINDOW_MS > now;
  const child = await hasUnusedChild(ctx.db, token);

  const invalidated = async (): Promise<Refresh> => {
    await invalidate(
      ctx,
      token.sessionId,
      [{ parent: token._id, after: null, skip: null }],
      now - REUSE_WINDOW_MS,
    );

    return ANSWERED;
  };

  if (!inWindow && child === false) return invalidated();

  const active = await activeToken(ctx.db, token.sessionId);

  if (active === "deep") {
    if (!inWindow && child === false) return invalidated();

    const fresh = await ctx.db.insert("authRefreshTokens", {
      sessionId: token.sessionId,
      expirationTime: now + SESSION_MS,
      parentRefreshTokenId: token._id,
    });

    return { kind: "library", refreshToken: `${fresh}${DIVIDER}${token.sessionId}` };
  }

  if (active?.parentRefreshTokenId === token._id || inWindow) return library;

  return invalidated();
};
