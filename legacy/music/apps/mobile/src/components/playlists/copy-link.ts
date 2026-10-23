/**
 * Copying a playlist's or album's link: the server names the path (`/playlists/<id>`), and the
 * link opens on the same address people type to reach the server, in a browser or in this app.
 */
import type { LinkKind } from "@music/commands/models";
import { useReadOnce } from "@music/sdk/react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { mediaUrl } from "@/lib/media-url";
import { useConnection } from "@/session/connection";

/** Copies the link to an album or playlist to the clipboard; rejects with the server's failure. */
export const useCopyLink = (): ((kind: LinkKind, id: string) => Promise<void>) => {
  const readLink = useReadOnce("links.get");
  const { origin } = useConnection();

  return async (kind, id) => {
    const link = await readLink({ kind, id });

    await Clipboard.setStringAsync(mediaUrl(origin, link.path));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
};
