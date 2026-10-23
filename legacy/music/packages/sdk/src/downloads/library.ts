/**
 * The songs, albums, and playlists this device holds, as a Downloaded library lists them. Pure,
 * read from a `DownloadsSnapshot`: what plays without the server, and the downloads that keep it.
 */
import type { AlbumId } from "@music/commands/ids";
import type { DownloadPin, DownloadTarget } from "@music/commands/models";

import { downloadStatus } from "./status";
import type { DownloadStatus } from "./status";
import type { DownloadsSnapshot, DownloadUsage, LocalCopy, PinView } from "./sync";

/** A song, album, or playlist someone downloaded to this device, finished or still coming. */
export interface DownloadedItem {
  readonly target: DownloadTarget;
  readonly title: string;
  /** The artist of a song or album; the owner of a playlist. */
  readonly subtitle: string;
  /** How many songs it has, or null until its first manifest arrives. */
  readonly songs: number | null;
  /** Space its songs take on this device so far. */
  readonly bytes: number;
  /** Its cover: a playlist's own from the server, else the file of one of its songs here. */
  readonly artUri: string | null;
  readonly status: DownloadStatus;
}

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
  /**
   * Each download in the server's order. One the server no longer lets this device read is left
   * out: it keeps no songs, and Remove all downloads still removes it.
   */
  readonly downloads: ReadonlyArray<DownloadedItem>;
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

/** The songs of a download this device holds: a song's own copy, or its members' copies. */
const heldCopies = (
  snapshot: DownloadsSnapshot,
  { pin, members }: PinView,
): ReadonlyArray<LocalCopy> =>
  (pin.target.kind === "track" ? [pin.target.id] : (members ?? []).map((m) => m.trackId)).flatMap(
    (trackId) => {
      const copy = snapshot.copies.get(trackId);

      return copy === undefined ? [] : [copy];
    },
  );

/** Each download a snapshot keeps, with where it stands and what it holds here. */
const downloadedItems = (snapshot: DownloadsSnapshot): ReadonlyArray<DownloadedItem> =>
  snapshot.pins.flatMap((view): ReadonlyArray<DownloadedItem> => {
    const { pin, members } = view;

    if (!pin.available) return [];
    const held = heldCopies(snapshot, view);
    const songArt = held.find((copy) => copy.artUri !== null)?.artUri ?? null;

    return [
      {
        target: pin.target,
        title: pin.title,
        subtitle: pin.subtitle,
        songs: pin.target.kind === "track" ? 1 : (members?.length ?? null),
        bytes: held.reduce((total, copy) => total + copy.bytes, 0),
        artUri: pin.target.kind === "playlist" ? (pin.artUrl ?? songArt) : (songArt ?? pin.artUrl),
        status: downloadStatus(snapshot, pin.target),
      },
    ];
  });

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

  return { downloads: downloadedItems(snapshot), albums, playlists, songs, usage: snapshot.usage };
};
