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

export type SessionDoc = Doc<"togetherSessions">;

export type MemberDoc = Doc<"togetherMembers">;

const NOT_IN = "You are not in a group session in this domain";

/** Each refusal's code and message; a session the caller is not in reads as none at all. */
const refusals = {
  service: ["not_found", NOT_IN],
  outside: ["not_found", NOT_IN],
  scope: ["forbidden", "This session lacks the scope to play in this domain"],
  guest: ["forbidden", "A guest joins a group session only from the link shared with them"],
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

/** Where `userId`, whose row in the session's domain is `row`, stands in `session`. */
export const placeOf = (
  session: SessionDoc,
  userId: Id<"users">,
  row: MemberDoc | null,
): TogetherPlace => {
  if (row?.sessionId === session._id) {
    if (row.state === "pending") return "pending";

    return session.hostId === userId ? "host" : "guest";
  }

  return session.blocked.includes(userId) ? "blocked" : "outside";
};

/** The facts `can` reads about `session` for someone standing at `place` in it. */
export const factsOf = (
  session: SessionDoc,
  place: TogetherPlace,
  addedIt = false,
): TogetherResource => ({
  on: "together",
  domain: session.item.domain,
  session: { live: session.state === "live", place, settings: session.settings, addedIt },
});

/** The caller's session in a domain, their row in it, and where they stand. */
export interface InSession {
  readonly session: SessionDoc;
  readonly member: MemberDoc;
  readonly place: TogetherPlace;
}

/**
 * Loads the caller's session in `domain` and decides `action` on it. Without one it fails
 * `not_found`, as for a session they are not in; a refusal fails with its own code. `addedIt`
 * says the caller queued the entry the action names.
 */
export const requireTogether = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  domain: ContentDomain,
  action: Exclude<TogetherAction, "start" | "join" | "ask">,
  addedIt = false,
): Promise<InSession> => {
  const member = await memberIn(ctx.db, caller.userId, domain);
  const session = member === null ? null : await ctx.db.get(member.sessionId);

  if (member === null || session === null) {
    const decision = can(caller, action, { on: "together", domain, session: null });

    return decision.allowed ? fail("not_found", NOT_IN) : refuse(decision);
  }

  const place = placeOf(session, caller.userId, member);
  const decision = can(caller, action, factsOf(session, place, addedIt));

  return decision.allowed ? { session, member, place } : refuse(decision);
};
