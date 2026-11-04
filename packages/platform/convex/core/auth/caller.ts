import { getAuthSessionId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import { restrictions } from "../../../commands/access";
import { callerScope, credentialScope, role } from "../../../commands/scopes";
import type { CallerScope } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalQuery } from "../../_generated/server";
import type { ActionCtx, DatabaseReader, QueryCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { heldScopes, restrictionsOf } from "../permissions/policy";
import type { PersonDoc } from "../permissions/policy";
import { liveSession } from "../sessions";

const callerValidator = v.object({
  kind: v.literal("person"),
  userId: v.id("users"),
  username: v.string(),
  role,
  sessionId: v.id("authSessions"),
  sessionKind: v.union(v.literal("password"), v.literal("apiKey"), v.literal("deviceCode")),
  /** The credential scopes the session holds now; `signed-in` is implied. */
  scopes: v.array(credentialScope),
  /** The person's restrictions, read live on this call. */
  restrictions: v.union(restrictions, v.null()),
});

/** The signed-in person a scoped command runs as, checked live on this call. */
export type Caller = Infer<typeof callerValidator>;

/**
 * The caller of a session, or a refusal: `unauthenticated` when the session is not live,
 * `forbidden` for a service's session or one that lacks `scope`. Everything `requireCaller` does
 * after reading the session id from the token.
 */
export const callerOfSession = async (
  db: DatabaseReader,
  sessionId: Id<"authSessions">,
  scope: CallerScope,
): Promise<Caller> => {
  const live = await liveSession(db, sessionId, Date.now());

  if (live === null) return fail("unauthenticated", "This session has ended; sign in again");

  const { session, user } = live;

  if (user.kind === "service") {
    return fail("forbidden", "A service principal runs only server functions");
  }

  const caller: Caller = {
    kind: "person",
    userId: user._id,
    username: user.username,
    role: user.role,
    sessionId,
    sessionKind: session.kind,
    scopes: heldScopes(session, user),
    restrictions: restrictionsOf(user),
  };

  return scope === "signed-in" || caller.scopes.includes(scope)
    ? caller
    : fail("forbidden", `This session lacks the ${scope} scope`);
};

/**
 * The caller of a query or mutation, or a refusal: `unauthenticated` without a live session,
 * `forbidden` for a service or when the session lacks `scope`.
 */
export const requireCaller = async (
  ctx: Pick<QueryCtx, "auth" | "db">,
  scope: CallerScope,
): Promise<Caller> => {
  const sessionId = ctx.db.normalizeId("authSessions", (await getAuthSessionId(ctx)) ?? "");

  if (sessionId === null) return fail("unauthenticated", "Sign in first");

  return callerOfSession(ctx.db, sessionId, scope);
};

/** The caller's person row, read again; a person who vanished meanwhile must sign in. */
export const callerUser = async (ctx: Pick<QueryCtx, "db">, caller: Caller): Promise<PersonDoc> => {
  const user = await ctx.db.get(caller.userId);

  return user?.kind === "person" ? user : fail("unauthenticated", "Sign in first");
};

export const refuseKeys = (caller: Caller): Caller =>
  caller.sessionKind === "apiKey"
    ? fail("forbidden", "API keys cannot do this; sign in with a password or a device")
    : caller;

/**
 * The caller of an action as of its start. A mutation it runs that must not outlive a revocation
 * calls `requireCaller` again.
 */
export const requireActionCaller = (
  ctx: Pick<ActionCtx, "runQuery">,
  scope: CallerScope,
): Promise<Caller> => ctx.runQuery(internal.core.auth.caller.check, { scope });

/** `requireCaller` for `requireActionCaller`; the caller's identity travels with `runQuery`. */
export const check = internalQuery({
  args: { scope: callerScope },
  returns: callerValidator,
  handler: (ctx, { scope }) => requireCaller(ctx, scope),
});
