import { ticketPurposes, ticketResourceKinds } from "@media/contracts/ticket";
import { v } from "convex/values";

import { domainItem } from "../../commands/access";
import { internalMutation, internalQuery } from "../_generated/server";
import { callerOfSession } from "./auth/caller";
import { fail } from "./lib/errors";
import { requirePlayable } from "./permissions/items";
import { liveSession } from "./sessions";
import { issuePersonalTicket, issueShareableTicket } from "./tickets";

const issuedTicket = v.object({ ticket: v.string(), expiresAt: v.number() });

/** Issues a personal ticket for a session a stack test signed in, as a domain command will. */
export const issuePersonal = internalMutation({
  args: {
    sessionId: v.id("authSessions"),
    resource: v.object({
      kind: v.union(...ticketResourceKinds.map((kind) => v.literal(kind))),
      id: v.string(),
    }),
    purpose: v.union(...ticketPurposes.map((purpose) => v.literal(purpose))),
    lifetimeMs: v.optional(v.number()),
  },
  returns: issuedTicket,
  handler: async (ctx, { sessionId, ...request }) => {
    const live = await liveSession(ctx.db, sessionId, Date.now());

    if (live === null) return fail("unauthenticated", "This session has ended; sign in again");

    return issuePersonalTicket(ctx, { userId: live.user._id, sessionId }, request);
  },
});

/**
 * Plays an item for a session a stack test signed in: decides that the session may play it, then
 * issues a play ticket for its file.
 */
export const play = internalMutation({
  args: { sessionId: v.id("authSessions"), item: domainItem },
  returns: issuedTicket,
  handler: async (ctx, { sessionId, item }) => {
    const caller = await callerOfSession(ctx.db, sessionId, "signed-in");

    await requirePlayable(ctx.db, caller, item);

    return issuePersonalTicket(ctx, caller, {
      resource: { kind: "file", id: item.ref.id },
      purpose: "play",
    });
  },
});

/** Issues the shareable ticket for one artwork, as a presentation query will. */
export const issueShareable = internalQuery({
  args: { artworkId: v.string() },
  returns: issuedTicket,
  handler: (_ctx, { artworkId }) => issueShareableTicket({ kind: "artwork", id: artworkId }),
});
