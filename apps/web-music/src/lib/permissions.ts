import type { PlaylistAccess } from "@/lib/models";
import type { Me } from "@/lib/platform";

/**
 * What the music client offers a role, as old music's `can` did (`legacy/music/packages/commands/src/permissions.ts`):
 * `share` lists other people and shares playlists with them, which guests may not; `admin` runs
 * the server from the account client. The core decides every command again (ADR 0005).
 */
type Capability = "user" | "share" | "admin";

const CAPABILITIES: Readonly<Record<Me["role"], ReadonlySet<Capability>>> = {
  owner: new Set(["user", "share", "admin"]),
  admin: new Set(["user", "share", "admin"]),
  member: new Set(["user", "share"]),
  guest: new Set(["user"]),
};

/** Whether `role` is offered `capability`. */
export const can = (role: Me["role"], capability: Capability): boolean =>
  CAPABILITIES[role].has(capability);

const PLAYLIST_RANK: Readonly<Record<PlaylistAccess, number>> = {
  viewer: 0,
  collaborator: 1,
  owner: 2,
};

/** Whether `access` lets someone add, remove, and reorder a playlist's songs. */
export const canEditPlaylistItems = (access: PlaylistAccess): boolean =>
  PLAYLIST_RANK[access] >= PLAYLIST_RANK.collaborator;

/** Whether `access` lets someone rename, describe, share, or delete a playlist. */
export const canManagePlaylist = (access: PlaylistAccess): boolean => access === "owner";
