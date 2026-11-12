import type { Me } from "@/session/me";

/**
 * Whether `me` may open the owner screens: an owner or an admin holding the `admin` scope, as the
 * server's library, user, import, and backup commands need.
 */
export const mayOpenOwnerSettings = (me: Me): boolean =>
  (me.role === "owner" || me.role === "admin") && me.scopes.includes("admin");
