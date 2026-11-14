import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { asAlbumId, asPlaylistId, asTrackId } from "@/lib/models";
import { useMusic } from "@/lib/platform";
import { useServer } from "@/session/connection";

export type LinkKind = "album" | "playlist" | "track";

/**
 * Copies the link to an album, playlist, or song on the music web client beside the media server,
 * where installs serve it (`<server>/music`). The record it names is read first, which checks that
 * you can open it; a song opens its album with the song highlighted. Rejects with the core's
 * failure.
 */
export const useCopyLink = (): ((kind: LinkKind, id: string) => Promise<void>) => {
  const music = useMusic();
  const { mediaUrl } = useServer();
  const page = (path: string): string => `${mediaUrl}/music/${path}`;

  const linkFor = async (kind: LinkKind, id: string): Promise<string> => {
    if (kind === "album") {
      const { album } = await music.albums.get({ albumId: asAlbumId(id) });

      return page(`albums/${album.id}`);
    }

    if (kind === "playlist") {
      const playlist = await music.playlists.get({ playlistId: asPlaylistId(id) });

      return page(`playlists/${playlist.id}`);
    }

    const track = await music.tracks.get({ trackId: asTrackId(id) });

    return page(`albums/${track.albumId}?track=${track.id}`);
  };

  return async (kind, id) => {
    await Clipboard.setStringAsync(await linkFor(kind, id));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
};
