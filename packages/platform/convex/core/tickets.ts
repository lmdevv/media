import {
  loadTicketKeyRing,
  PERSONAL_TICKET_MAX_MS,
  TICKET_KEYS_SETTING,
} from "@media/contracts/ticket";
import type {
  ArtworkResource,
  IssuedTicket,
  TicketKeyRing,
  TicketPurpose,
  TicketResource,
} from "@media/contracts/ticket";
import { v } from "convex/values";

import type { MutationCtx } from "../_generated/server";
import type { Caller } from "./auth/caller";
import { fail } from "./lib/errors";
import { serverQuery } from "./lib/serverFacing";
import { liveSession } from "./sessions";

const MIN_LIFETIME_MS = 1000;

const keyRing = async (): Promise<TicketKeyRing> => {
  const loaded = await loadTicketKeyRing(process.env[TICKET_KEYS_SETTING] ?? "");

  if (!loaded.ok) {
    throw new Error(
      `${TICKET_KEYS_SETTING} is not usable on this deployment: ${loaded.error.problem}`,
    );
  }

  return loaded.value;
};

interface PersonalTicketFor {
  readonly resource: TicketResource;
  readonly purpose: TicketPurpose;
  readonly lifetimeMs?: number | undefined;
}

/**
 * Issues a ticket for the caller's own session, after the domain command's own access check. It
 * expires after `lifetimeMs`, at most 6 h, and never after the session does.
 *
 * Takes a mutation context so a query cannot call it: a cached query result would hand out an old
 * personal ticket. Refuses `unauthenticated` when the session is not live or ends within a second,
 * and `invalid_args` for a lifetime under 1 s or not whole.
 */
export const issuePersonalTicket = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Pick<Caller, "userId" | "sessionId">,
  request: PersonalTicketFor,
): Promise<IssuedTicket> => {
  const now = Date.now();
  const live = await liveSession(ctx.db, caller.sessionId, now);

  if (
    live === null ||
    live.session.userId !== caller.userId ||
    live.session.expirationTime < now + MIN_LIFETIME_MS
  ) {
    return fail("unauthenticated", "This session has ended; sign in again");
  }

  const lifetimeMs = request.lifetimeMs ?? PERSONAL_TICKET_MAX_MS;

  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < MIN_LIFETIME_MS) {
    return fail("invalid_args", "A ticket lasts at least 1 second, in whole milliseconds");
  }

  const ring = await keyRing();

  return ring.issuePersonal({
    principal: { userId: caller.userId, sessionId: caller.sessionId },
    resource: request.resource,
    purpose: request.purpose,
    now,
    lifetimeMs,
    notAfter: live.session.expirationTime,
  });
};

/**
 * Issues a ticket for artwork that names no one. Every call in one 7-day bucket returns the same
 * string, valid one to two buckets, so a query may call it and image caches keep working.
 */
export const issueShareableTicket = async (resource: ArtworkResource): Promise<IssuedTicket> => {
  const ring = await keyRing();

  return ring.issueShareable({ resource, now: Date.now() });
};

/**
 * Whether the auth session a personal ticket names is still live, for the server to watch. It
 * reruns when the session or its user changes: sign-out, `endAll`, a key revoke. It does not
 * rerun as time passes, so the server ends the session itself at `endsAt`. A session that is not
 * the given user's, or is no session at all, is `ended`.
 */
export const sessionStatus = serverQuery({
  args: { userId: v.string(), sessionId: v.string() },
  returns: v.union(
    v.object({ state: v.literal("live"), endsAt: v.number() }),
    v.object({ state: v.literal("ended") }),
  ),
  handler: async (ctx, { userId, sessionId }) => {
    const id = ctx.db.normalizeId("authSessions", sessionId);
    const live = id === null ? null : await liveSession(ctx.db, id, Date.now());

    return live !== null && live.session.userId === userId
      ? { state: "live" as const, endsAt: live.session.expirationTime }
      : { state: "ended" as const };
  },
});
