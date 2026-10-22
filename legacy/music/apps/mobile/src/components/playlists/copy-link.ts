/**
 * Copying a playlist's link: the server names the path (`/playlists/<id>`), and the link opens
 * on the same address people type to reach the server, in a browser or in this app.
 */
import type { PlaylistId } from "@music/commands/ids";
import { useReadOnce } from "@music/sdk/react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { mediaUrl } from "@/lib/media-url";
import { useConnection } from "@/session/connection";

/** Copies a playlist's link to the clipboard; rejects with the server's failure. */
export const useCopyPlaylistLink = (): ((playlistId: PlaylistId) => Promise<void>) => {
  const readLink = useReadOnce("links.get");
  const { origin } = useConnection();

  return async (playlistId) => {
    const link = await readLink({ kind: "playlist", id: playlistId });

    await Clipboard.setStringAsync(mediaUrl(origin, link.path));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
};
