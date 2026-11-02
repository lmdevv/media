import type { PlaylistId } from "@music/commands/ids";
import type { PlaylistDetail } from "@music/commands/models";
import { useReadSettled } from "@music/sdk/react";

import { detailStateOf } from "@/lib/detail-state";
import type { DetailState } from "@/lib/detail-state";

/** Where a playlist stands for the viewer. */
export type PlaylistState = DetailState<PlaylistDetail>;

/** Subscribes to `playlists.get`; never throws. */
export const usePlaylist = (playlistId: PlaylistId): PlaylistState =>
  detailStateOf(useReadSettled("playlists.get", { playlistId }), "Couldn’t load this playlist.");
