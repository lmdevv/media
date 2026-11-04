import { ConvexError } from "convex/values";

import type { CallerScope } from "../../../commands/scopes";
import type { QueryCtx } from "../../_generated/server";

/** The signed-in principal a scoped command runs as. */
export interface Caller {
  readonly scope: CallerScope;
}

/**
 * The caller of a command that needs a signed-in session, or a rejected call. The core has no
 * sign-in yet, so every scoped call is rejected as `unauthenticated`.
 */
export const requireCaller = async (
  _ctx: Pick<QueryCtx, "auth">,
  scope: CallerScope,
): Promise<Caller> => Promise.reject(new ConvexError({ code: "unauthenticated", scope }));
