import { v } from "convex/values";

import { internalMutation, internalQuery } from "../_generated/server";
import { SESSION_MS } from "./sessions";

/** Most sessions or refresh tokens one seed writes, and most rows `left` counts. */
const PROBE_ROWS_MAX = 1000;

const checkCount = (name: string, count: number): void => {
  if (!Number.isSafeInteger(count) || count < 1 || count > PROBE_ROWS_MAX) {
    throw new Error(`seedSessions writes 1 to ${PROBE_ROWS_MAX} ${name}; got ${count}`);
  }
};

/**
 * Opens `sessions` live password sessions for a person, as that many sign-ins would, and gives
 * the first `tokens` refresh tokens, so the stack suite can end more sessions and tokens than one
 * call of `core/maintenance:endAllSessions` does. Answers the first session.
 *
 * @throws Error when the user is not a person, or a count is not a whole number from 1 to 1,000.
 */
export const seedSessions = internalMutation({
  args: { userId: v.id("users"), sessions: v.number(), tokens: v.number() },
  returns: v.id("authSessions"),
  handler: async (ctx, { userId, sessions, tokens }) => {
    checkCount("sessions", sessions);
    checkCount("refresh tokens", tokens);

    const user = await ctx.db.get(userId);

    if (user?.kind !== "person") throw new Error(`No person ${userId} to open sessions for`);

    const expirationTime = Date.now() + SESSION_MS;

    const [first] = await Promise.all(
      Array.from({ length: sessions }, async () =>
        ctx.db.insert("authSessions", {
          userId,
          expirationTime,
          kind: "password",
          generation: user.sessionGeneration,
        }),
      ),
    );

    if (first === undefined) throw new Error("seedSessions opened no session");

    await Promise.all(
      Array.from({ length: tokens }, async () =>
        ctx.db.insert("authRefreshTokens", { sessionId: first, expirationTime }),
      ),
    );

    return first;
  },
});

/** How many sessions a user still has, and refresh tokens a session still has, up to 1,000 each. */
export const left = internalQuery({
  args: { userId: v.id("users"), sessionId: v.id("authSessions") },
  returns: v.object({ sessions: v.number(), tokens: v.number() }),
  handler: async (ctx, { userId, sessionId }) => {
    const [sessions, tokens] = await Promise.all([
      ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .take(PROBE_ROWS_MAX),
      ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
        .take(PROBE_ROWS_MAX),
    ]);

    return { sessions: sessions.length, tokens: tokens.length };
  },
});
