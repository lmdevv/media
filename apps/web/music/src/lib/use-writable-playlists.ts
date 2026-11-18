import type { Playlist } from "@/lib/models";
import { useAllRows } from "@/lib/pages";
import { canEditPlaylistItems } from "@/lib/permissions";
import { useMusic } from "@/lib/platform";

/**
 * The playlists you can add songs to: your own, then those shared with you as a collaborator.
 * Undefined while loading.
 */
export const useWritablePlaylists = (): ReadonlyArray<Playlist> | undefined => {
  const music = useMusic();
  const own = useAllRows(music.playlists.list, (paginationOpts) => ({ paginationOpts }));
  const shared = useAllRows(music.playlists.shared, (paginationOpts) => ({ paginationOpts }));

  if (own === undefined || shared === undefined) return undefined;

  return [...own, ...shared.filter((playlist) => canEditPlaylistItems(playlist.access))];
};
