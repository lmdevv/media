import type { PlaylistDetail, PlaylistId } from "@/lib/models";

import { detailStateOf } from "@/lib/detail-state";
import type { DetailState } from "@/lib/detail-state";
import { usePlaylistDetail } from "@/lib/details";

/** Where a playlist stands for the viewer. */
export type PlaylistState = DetailState<PlaylistDetail>;

/** Follows the playlist and every one of its entries; never throws. */
export const usePlaylist = (playlistId: PlaylistId): PlaylistState =>
  detailStateOf(usePlaylistDetail(playlistId), "Couldn’t load this playlist.");
