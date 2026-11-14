import type { Me } from "./models";

/**
 * What the signed-in person may do, from the core's role and the scopes this session holds
 * (ADR 0005):
 *
 * - `keys`: create and revoke API keys for the CLI and agents. Not guests.
 * - `share`: see who else is on the server and share playlists with them. Not guests.
 * - `admin`: run the server: people, invites, libraries, and jobs.
 * - `owner`: hand the server to someone else.
 */
export type Capability = "keys" | "share" | "admin" | "owner";

const RULES = {
  keys: (me) => me.role !== "guest" && me.scopes.includes("account"),
  share: (me) => me.role !== "guest" && me.scopes.includes("music:edit"),
  admin: (me) => (me.role === "owner" || me.role === "admin") && me.scopes.includes("admin"),
  owner: (me) => me.role === "owner" && me.scopes.includes("admin"),
} as const satisfies Record<Capability, (me: Pick<Me, "role" | "scopes">) => boolean>;

export const can = (me: Pick<Me, "role" | "scopes">, capability: Capability): boolean =>
  RULES[capability](me);

type PlaylistAccess = "owner" | "collaborator" | "viewer";

/** Whether someone may add, remove, and reorder a playlist's songs: its owner or a collaborator. */
export const canEditPlaylistItems = (access: PlaylistAccess): boolean =>
  access === "owner" || access === "collaborator";

/** Whether someone may rename, share, or delete a playlist: only its owner. */
export const canManagePlaylist = (access: PlaylistAccess): boolean => access === "owner";

const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
} as const satisfies Record<Me["role"], string>;

export const roleLabel = (role: Me["role"]): string => ROLE_LABELS[role];

const FORBIDDEN_MESSAGES = {
  keys: "Guests can't use API keys",
  share: "Guests can't share with other people",
  admin: "Only an admin can do that",
  owner: "Only the owner can do that",
} as const satisfies Record<Capability, string>;

export const forbiddenMessage = (capability: Capability): string => FORBIDDEN_MESSAGES[capability];
