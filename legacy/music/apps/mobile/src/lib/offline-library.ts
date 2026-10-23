/**
 * What the pages read from this phone's downloads while the server is out of reach: Home's rail
 * of downloaded albums (D14), and an album or playlist page the server can't load.
 */
import type { AlbumId, PlaylistId } from "@music/commands/ids";
import type { AlbumCard } from "@music/commands/models";
import type { LocalCopy, OfflineAlbum, OfflineLibrary } from "@music/sdk/downloads";

/** An album as a card draws it. */
export type CardAlbum = Pick<AlbumCard, "id" | "title" | "artist" | "artUrl" | "year">;

/** A downloaded album as a card: its cover from this phone, and no year, which it doesn't keep. */
export const cardOf = (album: OfflineAlbum): CardAlbum => ({
  id: album.albumId,
  title: album.title,
  artist: album.artist,
  artUrl: album.artUri,
  year: null,
});

/** An album or playlist as its page draws it from this phone alone. */
export interface OfflineCollection {
  readonly title: string;
  /** An album's artist; a playlist's owner. */
  readonly subtitle: string;
  readonly artUri: string | null;
  /** The songs of it on this phone, in its order. */
  readonly tracks: ReadonlyArray<LocalCopy>;
}

/** The songs of an album this phone holds, or null when it holds none. */
export const offlineAlbum = (
  library: Pick<OfflineLibrary, "albums">,
  albumId: AlbumId,
): OfflineCollection | null => {
  const album = library.albums.find((held) => held.albumId === albumId);

  return album === undefined
    ? null
    : { title: album.title, subtitle: album.artist, artUri: album.artUri, tracks: album.tracks };
};

/**
 * A downloaded playlist with the songs of it this phone holds, or null when it isn't downloaded.
 * Its cover is a song's from this phone first: the server's signed URL won't load without it.
 */
export const offlinePlaylist = (
  library: Pick<OfflineLibrary, "playlists">,
  playlistId: PlaylistId,
): OfflineCollection | null => {
  const playlist = library.playlists.find((held) => held.pin.target.id === playlistId);

  if (playlist === undefined) return null;
  const { pin, tracks } = playlist;

  return {
    title: pin.title,
    subtitle: pin.subtitle,
    artUri: tracks.find((copy) => copy.artUri !== null)?.artUri ?? pin.artUrl,
    tracks,
  };
};
