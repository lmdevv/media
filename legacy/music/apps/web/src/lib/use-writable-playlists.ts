import type { Playlist } from "@music/commands/models";
import { canEditPlaylistItems } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";

/**
 * The playlists you can add songs to: your own, then those shared with you as a collaborator.
 * Undefined while loading.
 */
export const useWritablePlaylists = (): ReadonlyArray<Playlist> | undefined => {
  const own = useRead("playlists.list", {});
  const shared = useRead("playlists.shared", {});

  if (own === undefined || shared === undefined) return undefined;

  return [...own, ...shared.filter((playlist) => canEditPlaylistItems(playlist.access))];
};
