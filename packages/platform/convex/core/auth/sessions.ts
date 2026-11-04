import { register } from "../../../commands/core/auth/sessions";
import { fail } from "../lib/errors";
import { endSession, endUserSessions } from "../sessions";

export const { current, end, endAll } = register({
  current: (_ctx, _args, caller) => caller,
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
});
