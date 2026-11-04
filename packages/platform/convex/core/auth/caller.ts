import { getAuthSessionId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import { callerScope, credentialScope, role } from "../../../commands/scopes";
import type { CallerScope } from "../../../commands/scopes";
import { internal } from "../../_generated/api";
import { internalQuery } from "../../_generated/server";
import type { ActionCtx, QueryCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { heldScopes, liveSession } from "../sessions";

const callerValidator = v.object({
  userId: v.id("users"),
  username: v.string(),
  role,
  sessionId: v.id("authSessions"),
  kind: v.union(v.literal("password"), v.literal("apiKey"), v.literal("deviceCode")),
  /** The credential scopes the session holds now; `signed-in` is implied. */
  scopes: v.array(credentialScope),
});

/** The signed-in user a scoped command runs as, checked live on this call. */
export type Caller = Infer<typeof callerValidator>;

/**
 * The caller of a query or mutation, or a refusal: `unauthenticated` without a live session,
 * `forbidden` when the session lacks `scope`.
 */
export const requireCaller = async (
  ctx: Pick<QueryCtx, "auth" | "db">,
  scope: CallerScope,
): Promise<Caller> => {
  const sessionId = ctx.db.normalizeId("authSessions", (await getAuthSessionId(ctx)) ?? "");

  if (sessionId === null) return fail("unauthenticated", "Sign in first");

  const live = await liveSession(ctx.db, sessionId, Date.now());

  if (live === null) return fail("unauthenticated", "This session has ended; sign in again");

  const caller: Caller = {
    userId: live.user._id,
    username: live.user.username,
    role: live.user.role,
    sessionId,
    kind: live.session.kind,
    scopes: heldScopes(live.session, live.user),
  };

  return scope === "signed-in" || caller.scopes.includes(scope)
    ? caller
    : fail("forbidden", `This session lacks the ${scope} scope`);
};

export const refuseKeys = (caller: Caller): Caller =>
  caller.kind === "apiKey"
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
