import type { Infer } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { role, scope } from "./validators";

/** A session scope; `Scope` in `@media/contracts/scopes` lists the same values. */
export type Scope = Infer<typeof scope>;

/** An account role. */
export type Role = Infer<typeof role>;

/** Every scope each role allows; `roleScopes` in `@media/contracts/scopes` agrees. */
export const ROLE_SCOPES = {
  owner: ["read", "play", "account", "manage", "admin"],
  admin: ["read", "play", "account", "manage", "admin"],
  member: ["read", "play", "account"],
  service: ["media-service"],
} as const satisfies { readonly [R in Role]: ReadonlyArray<Scope> };

/** Whether the role administers the server: sees every library and manages others. */
export const isAdminRole = (userRole: Role): boolean =>
  userRole === "owner" || userRole === "admin";

/**
 * The scopes a session holds now. A grant's scopes are cut down to what the role allows today, so
 * demoting an admin strips `manage` and `admin` from their keys and devices at once. A password
 * session holds every scope of its role, except that the service account never has a password.
 */
export const sessionScopes = (
  session: Doc<"authSessions">,
  userRole: Role,
): ReadonlyArray<Scope> => {
  const allowed: ReadonlyArray<Scope> = ROLE_SCOPES[userRole];

  if (session.grant === undefined) return userRole === "service" ? [] : allowed;

  return session.grant.scopes.filter((granted) => allowed.includes(granted));
};
