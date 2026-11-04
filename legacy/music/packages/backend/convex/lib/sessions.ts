import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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

/** How long a session [music] opens itself lasts: Convex Auth's default, which `auth.ts` keeps. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ends every session a person has, password and API key alike, at once and in constant work,
 * touching only their user row: sessions created up to now stop counting
 * (`users.sessionsValidAfter`), and so do sessions from an earlier generation
 * (`users.sessionGeneration`), checked by `loadViewer`. The rows are purged in scheduled batches.
 * It reads no session, so sign-ins committing meanwhile, however many, can't make it retry until
 * it fails. Returns the new generation, for a session opened in the same mutation.
 */
export const endUserSessions = async (ctx: MutationCtx, userId: Id<"users">): Promise<number> => {
  const user = await ctx.db.get(userId);
  const generation = (user?.sessionGeneration ?? 0) + 1;

  if (user !== null) {
    await ctx.db.patch(userId, { sessionsValidAfter: Date.now(), sessionGeneration: generation });
  }

  await ctx.scheduler.runAfter(0, internal.people.purgeSessions, { userId, cursor: null });

  return generation;
};

/** Opens a session for `user` in their current generation, as `SESSION_MS` long. */
export const openSession = (
  ctx: MutationCtx,
  user: Doc<"users">,
  generation = user.sessionGeneration ?? 0,
): Promise<Id<"authSessions">> =>
  ctx.db.insert("authSessions", {
    userId: user._id,
    expirationTime: Date.now() + SESSION_MS,
    generation,
  });

/** Whether an API key was made before its person's keys stopped working (`keysValidAfter`). */
export const keyLapsed = (
  key: Pick<Doc<"apiKeys">, "_creationTime">,
  user: Pick<Doc<"users">, "keysValidAfter">,
): boolean => user.keysValidAfter !== undefined && key._creationTime <= user.keysValidAfter;

/**
 * Whether a session was ended by `endUserSessions` but its row is not purged yet. A session
 * [music] opened records its generation, which alone decides: a time cutoff can't tell a session
 * opened in the same transaction as the cutoff (a reset's own) from one before it. Sessions
 * Convex Auth opens itself (sign-up) have none and go by the cutoff time.
 */
export const isStale = (session: Doc<"authSessions">, user: Doc<"users">): boolean =>
  session.generation === undefined
    ? user.sessionsValidAfter !== undefined && session._creationTime <= user.sessionsValidAfter
    : session.generation < (user.sessionGeneration ?? 0);
