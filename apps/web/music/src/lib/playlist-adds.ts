import type { PlatformSdk } from "@media/sdk/promise";

import type { PlaylistId, TrackId } from "@/lib/models";

type Music = PlatformSdk["music"];

/**
 * Adds songs to the end of a playlist a call at a time: each call takes as many as it can read
 * within the core's limits and answers the rest. A failed call stops, since an add may have landed
 * even when its answer was lost; adds are never sent again blindly (#153), and the playlist on
 * screen shows what landed.
 */
export const addAllToPlaylist = async (
  music: Music,
  playlistId: PlaylistId,
  trackIds: ReadonlyArray<TrackId>,
): Promise<void> => {
  if (trackIds.length === 0) return;

  const added = await music.playlists.addTracks({ playlistId, trackIds: [...trackIds] });

  if (added.rest.length >= trackIds.length) throw new Error("The playlist stopped taking songs");

  await addAllToPlaylist(music, playlistId, added.rest);
};

/** Creates a playlist that starts with `trackIds`, adding whatever the first call left over. */
export const createPlaylist = async (
  music: Music,
  playlist: { readonly name: string; readonly trackIds: ReadonlyArray<TrackId> },
): Promise<PlaylistId> => {
  const created = await music.playlists.create(
    playlist.trackIds.length === 0
      ? { name: playlist.name }
      : { name: playlist.name, trackIds: [...playlist.trackIds] },
  );

  await addAllToPlaylist(music, created.playlistId, created.rest);

  return created.playlistId;
};
