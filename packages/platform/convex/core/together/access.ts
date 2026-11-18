import type { ContentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, QueryCtx } from "../../_generated/server";
import type { ErrorCode } from "../lib/errors";
import { fail } from "../lib/errors";
import { can } from "../permissions/policy";
import type {
  Decision,
  Principal,
  TogetherAction,
  TogetherBecause,
  TogetherPlace,
  TogetherResource,
} from "../permissions/policy";
import type { Settings } from "./model";

export type SessionDoc = Doc<"togetherSessions">;

export type MemberDoc = Doc<"togetherMembers">;

type FactsDoc = Doc<"togetherFacts">;

const NOT_IN = "You are not in a group session in this domain";

const LEFT = "You are no longer in that group session; it ended, or you left it";

/** Each refusal's code and message; a session the caller is not in reads as none at all. */
const refusals = {
  service: ["not_found", NOT_IN],
  outside: ["not_found", NOT_IN],
  scope: ["forbidden", "This session lacks the scope to play in this domain"],
  guest: [
    "forbidden",
    "A guest from a share link joins only through it, and cannot start a session or queue items",
  ],
  ended: ["expired", "This group session has ended"],
  blocked: ["forbidden", "The host removed you from this group session"],
  locked: ["forbidden", "This group session is locked and takes no new members"],
  "join-setting": ["forbidden", "This group session does not take members this way"],
  pending: ["forbidden", "The host has not let you in yet"],
  "not-host": ["forbidden", "Only the host can do this"],
  "no-control": ["forbidden", "The host has not let guests control playback"],
  "no-add": ["forbidden", "The host has not let guests add items"],
  "not-yours": ["forbidden", "You can take out only what you queued"],
} as const satisfies { readonly [B in TogetherBecause]: readonly [ErrorCode, string] };

/** Fails the call for a refusal of `can`. */
export const refuse = (
  decision: Extract<Decision<TogetherBecause>, { readonly allowed: false }>,
): never => {
  const [code, message] = refusals[decision.because];

  return fail(code, message);
};

/** The caller's one row in `domain`: the session they are in, waiting for, or saw end. */
export const memberIn = (
  db: DatabaseReader,
  userId: Id<"users">,
  domain: ContentDomain,
): Promise<MemberDoc | null> =>
  db
    .query("togetherMembers")
    .withIndex("by_user_domain", (q) => q.eq("userId", userId).eq("domain", domain))
    .unique();

/** Where `userId`, whose row `row` is in a session `hostId` hosts, stands in it. */
const placeInside = (hostId: Id<"users">, userId: Id<"users">, row: MemberDoc): TogetherPlace => {
  if (row.state === "pending") return "pending";

  return hostId === userId ? "host" : "guest";
};

/** Where `userId`, whose row in the session's domain is `row`, stands in `session`. */
export const placeOf = (
  session: SessionDoc,
  userId: Id<"users">,
  row: MemberDoc | null,
): TogetherPlace => {
  if (row?.sessionId === session._id) return placeInside(session.hostId, userId, row);

  return session.blocked.includes(userId) ? "blocked" : "outside";
};

/** What `factsOf` adds about the principal beyond where they stand. */
export interface Standing {
  /** They queued the entry a `remove` names. */
  readonly addedIt?: boolean;
  /** They are a guest whose share link names this session; only opening the link says so. */
  readonly invited?: boolean;
}

/** What `can` reads about a session besides where someone stands in it. */
interface Cold {
  readonly domain: ContentDomain;
  readonly live: boolean;
  readonly settings: Settings;
}

const factsAbout = (
  { domain, live, settings }: Cold,
  place: TogetherPlace,
  { addedIt = false, invited = false }: Standing = {},
): TogetherResource => ({
  on: "together",
  domain,
  session: { live, place, settings, addedIt, invited },
});

/** The facts `can` reads about `session` for someone standing at `place` in it. */
export const factsOf = (
  session: SessionDoc,
  place: TogetherPlace,
  standing: Standing = {},
): TogetherResource =>
  factsAbout(
    { domain: session.item.domain, live: session.state === "live", settings: session.settings },
    place,
    standing,
  );

/** Fails `action` for a caller in no session in `domain`: `not_found`, or the refusal's own code. */
const outside = (caller: Principal, action: TogetherAction, domain: ContentDomain): never => {
  const decision = can(caller, action, { on: "together", domain, session: null });

  return decision.allowed ? fail("not_found", NOT_IN) : refuse(decision);
};

/** The caller's session in a domain, their row in it, and where they stand. */
export interface InSession {
  readonly session: SessionDoc;
  readonly member: MemberDoc;
  readonly place: TogetherPlace;
}

/**
 * Loads the caller's session in `domain` and decides `action` on it. Without one it fails
 * `not_found`, as for a session they are not in; a refusal fails with its own code.
 *
 * With `sessionId`, the call was made for that session, and it fails `conflict` before anything
 * is decided once the caller's place in the domain is in another session or in none: they left
 * it, or it ended and they started or joined another. So a client's late write never lands in the
 * session that replaced the one it was made for (ADR 0017). A session that ended with the caller
 * still in it is decided as before, as ended.
 */
export const requireTogether = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  action: Exclude<TogetherAction, "start" | "join" | "ask">,
  sessionId?: Id<"togetherSessions">,
): Promise<InSession> => {
  const member = await memberIn(ctx.db, caller.userId, domain);

  if (sessionId !== undefined && member?.sessionId !== sessionId) return fail("conflict", LEFT);

  const session = member === null ? null : await ctx.db.get(member.sessionId);

  if (member === null || session === null) return outside(caller, action, domain);

  const place = placeOf(session, caller.userId, member);
  const decision = can(caller, action, factsOf(session, place));

  return decision.allowed ? { session, member, place } : refuse(decision);
};

/** The caller's place in their session's queue, as `requireQueue` decided it. */
export interface InQueue {
  /** The session, whose entries name it. */
  readonly sessionId: Id<"togetherSessions">;
  /** The facts `can` reads about the session for the caller, with what they did (`Standing`). */
  readonly factsFor: (standing: Standing) => TogetherResource;
}

/** The cold facts kept beside `sessionId` (`factsDocument`). */
export const factsIn = async (
  db: DatabaseReader,
  sessionId: Id<"togetherSessions">,
): Promise<FactsDoc> =>
  (await db
    .query("togetherFacts")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique()) ?? fail("not_found", NOT_IN);

/**
 * Loads the caller's session in `domain` and decides `view` on its queue, as `requireTogether`
 * does, from the session's cold facts rather than its document, so a query over its queue re-runs
 * on neither its clock nor what it plays (ADR 0017).
 */
export const requireQueue = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
): Promise<InQueue> => {
  const member = await memberIn(ctx.db, caller.userId, domain);

  if (member === null) return outside(caller, "view", domain);

  const cold = await factsIn(ctx.db, member.sessionId);
  const place = placeInside(cold.hostId, caller.userId, member);
  const factsFor = (standing: Standing): TogetherResource => factsAbout(cold, place, standing);
  const decision = can(caller, "view", factsFor({}));

  return decision.allowed ? { sessionId: cold.sessionId, factsFor } : refuse(decision);
};
