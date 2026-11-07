import { v } from "convex/values";

import { serviceScope } from "../../commands/scopes";
import { internalQuery } from "../_generated/server";
import { serviceOfSession } from "./auth/caller";

export const whoami = internalQuery({
  args: { sessionId: v.id("authSessions") },
  returns: v.object({ name: v.string(), scopes: v.array(serviceScope) }),
  handler: async (ctx, { sessionId }) => {
    const service = await serviceOfSession(ctx.db, sessionId, "media-service");

    return { name: service.name, scopes: [...service.scopes] };
  },
});
