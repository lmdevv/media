import { register } from "../../../commands/core/auth/sessions";
import { fail } from "../lib/errors";
import { endSession, endUserSessions } from "../sessions";

/** Convex Auth writes a refresh token as `<refreshTokenId>|<sessionId>`. */
const REFRESH_TOKEN_DIVIDER = "|";

export const { current, end, endAll, revoke } = register({
  current: (_ctx, _args, caller) => ({
    userId: caller.userId,
    username: caller.username,
    role: caller.role,
    sessionId: caller.sessionId,
    kind: caller.sessionKind,
    scopes: caller.scopes,
  }),
  end: async (ctx, { sessionId }, caller) => {
    const session = await ctx.db.get(sessionId);

    if (session?.userId !== caller.userId) return fail("not_found", "No such session");

    await endSession(ctx, sessionId);

    return null;
  },
  endAll: async (ctx, { keepCurrent }, caller) => {
    const user = await ctx.db.get(caller.userId);

    if (user !== null) {
      await endUserSessions(ctx, user, keepCurrent ? caller.sessionId : undefined);
    }

    return null;
  },
  /**
   * The refresh token is the proof: only a token row of that very session ends it, so nobody ends
   * a session whose refresh token they never held. Any token of the session works, a rotated or
   * invalidated one included, because Convex Auth keeps those rows until the session ends. A token
   * whose row is gone names a session that already ended, or one it cannot prove, so there is
   * nothing to end.
   */
  revoke: async (ctx, { refreshToken }) => {
    const [tokenPart, sessionPart] = refreshToken.split(REFRESH_TOKEN_DIVIDER);
    const tokenId = ctx.db.normalizeId("authRefreshTokens", tokenPart ?? "");
    const sessionId = ctx.db.normalizeId("authSessions", sessionPart ?? "");

    if (tokenId === null || sessionId === null) {
      return fail("invalid_args", "That is not a refresh token");
    }

    const token = await ctx.db.get(tokenId);

    if (token?.sessionId === sessionId) await endSession(ctx, sessionId);

    return { confirmed: true as const };
  },
});
