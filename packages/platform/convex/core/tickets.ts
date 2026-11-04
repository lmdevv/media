import { loadTicketKeyRing, TICKET_KEYS_SETTING } from "@media/contracts/ticket";
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

const importRing = async (text: string): Promise<TicketKeyRing> => {
  const loaded = await loadTicketKeyRing(text);

  if (!loaded.ok) {
    throw new Error(
      `${TICKET_KEYS_SETTING} is not usable on this deployment: ${loaded.error.problem}`,
    );
  }

  return loaded.value;
};

let imported: { readonly text: string; readonly ring: Promise<TicketKeyRing> } | undefined;

/** Imports the keys once per setting value, so a query that signs many tickets imports them once. */
const keyRing = (): Promise<TicketKeyRing> => {
  const text = process.env[TICKET_KEYS_SETTING] ?? "";

  if (imported?.text !== text) {
    const ring = importRing(text);

    imported = { text, ring };
    ring.catch(() => {
      if (imported?.ring === ring) imported = undefined;
    });
  }

  return imported.ring;
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
 * Takes a mutation context so a query cannot call it: a subscription keeps a query's result until
 * the data it read changes, so it would hold an old personal ticket. Refuses `unauthenticated`
 * when the session is not live or ends too soon for a ticket, and `invalid_args` for a lifetime
 * under 1 s or not whole.
 */
export const issuePersonalTicket = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Pick<Caller, "userId" | "sessionId">,
  request: PersonalTicketFor,
): Promise<IssuedTicket> => {
  const now = Date.now();
  const live = await liveSession(ctx.db, caller.sessionId, now);

  if (live === null || live.session.userId !== caller.userId) {
    return fail("unauthenticated", "This session has ended; sign in again");
  }

  const ring = await keyRing();

  const issued = await ring.issuePersonal({
    principal: { userId: caller.userId, sessionId: caller.sessionId },
    resource: request.resource,
    purpose: request.purpose,
    now,
    lifetimeMs: request.lifetimeMs,
    notAfter: live.session.expirationTime,
  });

  if (issued.ok) return issued.value;

  return issued.error.problem === "lifetime"
    ? fail("invalid_args", "A ticket lasts at least 1 second, in whole milliseconds")
    : fail("unauthenticated", "This session ends too soon for a ticket; sign in again");
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
