/**
 * The songs, albums, and playlists this device holds, as a Downloaded library lists them. Pure,
 * read from a `DownloadsSnapshot`, so it lists only what plays without the server.
 */
import type { AlbumId } from "@music/commands/ids";
import type { DownloadPin } from "@music/commands/models";

import type { DownloadsSnapshot, DownloadUsage, LocalCopy } from "./sync";

/** An album with at least one of its songs on this device. */
export interface OfflineAlbum {
  readonly albumId: AlbumId;
  readonly title: string;
  readonly artist: string;
  readonly artUri: string | null;
  /** Its songs on this device, by disc and number. */
  readonly tracks: ReadonlyArray<LocalCopy>;
}

/** A downloaded playlist with the songs of it this device holds, in its order. */
export interface OfflinePlaylist {
  readonly pin: Extract<DownloadPin, { readonly available: true }>;
  readonly tracks: ReadonlyArray<LocalCopy>;
}

/** Everything this device holds. */
export interface OfflineLibrary {
  readonly albums: ReadonlyArray<OfflineAlbum>;
  readonly playlists: ReadonlyArray<OfflinePlaylist>;
  /** Every song on this device, by title. */
  readonly songs: ReadonlyArray<LocalCopy>;
  readonly usage: DownloadUsage;
}

/** Disc, then number; songs without one go last. */
const byDiscAndNumber = (left: LocalCopy, right: LocalCopy): number =>
  (left.track.discNumber ?? Infinity) - (right.track.discNumber ?? Infinity) ||
  (left.track.trackNumber ?? Infinity) - (right.track.trackNumber ?? Infinity) ||
  left.track.title.localeCompare(right.track.title);

/**
 * The library a snapshot holds. Arrays built here are sorted in place: they are this function's
 * own, and Hermes has no `toSorted`.
 */
export const offlineLibrary = (snapshot: DownloadsSnapshot): OfflineLibrary => {
  const songs = [...snapshot.copies.values()];
  songs.sort((left, right) => left.track.title.localeCompare(right.track.title));
  const grouped = new Map<AlbumId, Array<LocalCopy>>();

  for (const copy of songs) {
    const tracks = grouped.get(copy.track.albumId);

    if (tracks === undefined) grouped.set(copy.track.albumId, [copy]);
    else tracks.push(copy);
  }

  const albums = Array.from(grouped, ([albumId, tracks]): OfflineAlbum => {
    tracks.sort(byDiscAndNumber);
    const first = tracks[0];

    return {
      albumId,
      title: first?.track.album ?? "",
      artist: first?.track.artist ?? "",
      artUri: tracks.find((copy) => copy.artUri !== null)?.artUri ?? null,
      tracks,
    };
  });

  albums.sort((left, right) => left.title.localeCompare(right.title));

  const playlists = snapshot.pins.flatMap(({ pin, members }): ReadonlyArray<OfflinePlaylist> => {
    if (!pin.available || pin.target.kind !== "playlist") return [];

    const tracks = (members ?? []).flatMap((member) => {
      const copy = snapshot.copies.get(member.trackId);

      return copy === undefined ? [] : [copy];
    });

    return [{ pin, tracks }];
  });

  return { albums, playlists, songs, usage: snapshot.usage };
};
