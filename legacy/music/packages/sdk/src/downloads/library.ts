/**
 * The songs, albums, and playlists this device holds, as a Downloaded library lists them. Pure,
 * read from a `DownloadsSnapshot`: what plays without the server, and the downloads that keep it.
 */
import type { AlbumId, TrackId } from "@music/commands/ids";
import type { DownloadPin, DownloadTarget } from "@music/commands/models";

import { targetKey } from "./plan";
import { downloadStatus, holdersOf, progressOf } from "./status";
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
  /** Space removing it frees: its songs here that no other download keeps. */
  readonly freedBytes: number;
  /** Its cover: a playlist's own from the server, else the file of one of its songs here. */
  readonly artUri: string | null;
  readonly status: DownloadStatus;
}

/**
 * The songs downloaded on their own that no downloaded album or playlist holds. A song one holds
 * shows only there; its own download stays, so it comes back here once that album or playlist goes.
 */
export interface DownloadedSongs {
  /** Each song's own download, in the server's order. */
  readonly items: ReadonlyArray<DownloadedSong>;
  readonly bytes: number;
  readonly artUri: string | null;
  /** Where the group stands, counted over its songs as one download. */
  readonly status: DownloadStatus;
}

/** An album or playlist download. */
export type DownloadedCollection = DownloadedItem & {
  readonly target: Exclude<DownloadTarget, { readonly kind: "track" }>;
};

/** A song's own download. */
export type DownloadedSong = DownloadedItem & {
  readonly target: Extract<DownloadTarget, { readonly kind: "track" }>;
};

/** One row of every download: an album or playlist, or the songs downloaded on their own. */
export type DownloadedEntry =
  | { readonly kind: "download"; readonly item: DownloadedCollection }
  | { readonly kind: "songs"; readonly songs: DownloadedSongs };

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
  /**
   * Every download as one list shows it: each album and playlist, then `ownSongs` as one row
   * while it holds any.
   */
  readonly entries: ReadonlyArray<DownloadedEntry>;
  readonly ownSongs: DownloadedSongs;
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

const keptTracks = ({ pin, members }: PinView): ReadonlyArray<TrackId> =>
  pin.target.kind === "track" ? [pin.target.id] : (members ?? []).map((member) => member.trackId);

/** The songs a download lists, which syncing keeps for it; none until its first manifest. */
const listed = ({ members }: PinView): ReadonlySet<TrackId> =>
  new Set((members ?? []).map((member) => member.trackId));

const keeperCounts = (snapshot: DownloadsSnapshot): ReadonlyMap<TrackId, number> => {
  const keepers = new Map<TrackId, number>();

  for (const view of snapshot.pins) {
    for (const trackId of listed(view)) keepers.set(trackId, (keepers.get(trackId) ?? 0) + 1);
  }

  return keepers;
};

const heldCopies = (snapshot: DownloadsSnapshot, view: PinView): ReadonlyArray<LocalCopy> =>
  [...new Set(keptTracks(view))].flatMap((trackId) => {
    const copy = snapshot.copies.get(trackId);

    return copy === undefined ? [] : [copy];
  });

const sizeOf = (held: ReadonlyArray<{ readonly bytes: number }>): number =>
  held.reduce((total, { bytes }) => total + bytes, 0);

/** The space of `held` that leaves with `view`: the songs no other download lists. */
const freedBy = (
  view: PinView,
  held: ReadonlyArray<LocalCopy>,
  keepers: ReadonlyMap<TrackId, number>,
): number => {
  const own = listed(view);

  return sizeOf(
    held.filter(({ track }) => (keepers.get(track.id) ?? 0) - (own.has(track.id) ? 1 : 0) === 0),
  );
};

/** Space removing the download of `target` frees: its songs here that no other download keeps. */
export const freedBytesOf = (snapshot: DownloadsSnapshot, target: DownloadTarget): number => {
  const key = targetKey(target);
  const view = snapshot.pins.find(({ pin }) => targetKey(pin.target) === key);

  return view === undefined ? 0 : freedBy(view, heldCopies(snapshot, view), keeperCounts(snapshot));
};

interface Kept {
  readonly item: DownloadedItem;
  readonly members: PinView["members"];
}

/** Each download a snapshot keeps, with where it stands and what it holds here. */
const keptDownloads = (snapshot: DownloadsSnapshot): ReadonlyArray<Kept> => {
  const keepers = keeperCounts(snapshot);

  return snapshot.pins.flatMap((view): ReadonlyArray<Kept> => {
    const { pin, members } = view;

    if (!pin.available) return [];

    const held = heldCopies(snapshot, view);
    const songArt = held.find((copy) => copy.artUri !== null)?.artUri ?? null;

    const item: DownloadedItem = {
      target: pin.target,
      title: pin.title,
      subtitle: pin.subtitle,
      songs: pin.target.kind === "track" ? 1 : (members?.length ?? null),
      bytes: sizeOf(held),
      freedBytes: freedBy(view, held, keepers),
      artUri: pin.target.kind === "playlist" ? (pin.artUrl ?? songArt) : (songArt ?? pin.artUrl),
      status: downloadStatus(snapshot, pin.target),
    };

    return [{ item, members }];
  });
};

const ownSongsOf = (snapshot: DownloadsSnapshot, kept: ReadonlyArray<Kept>): DownloadedSongs => {
  const holders = holdersOf(snapshot);

  const own = kept.flatMap(({ item, members }) => {
    const { target } = item;

    if (target.kind !== "track" || holders.has(target.id)) return [];

    return [
      {
        item: { ...item, target },
        members: members ?? [{ trackId: target.id, state: "fetchable" } as const],
      },
    ];
  });

  const items = own.map(({ item }) => item);

  return {
    items,
    bytes: sizeOf(items),
    artUri: items.find((item) => item.artUri !== null)?.artUri ?? null,
    status: progressOf(
      snapshot,
      own.flatMap(({ members }) => members),
    ),
  };
};

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

  const kept = keptDownloads(snapshot);
  const downloads = kept.map(({ item }) => item);
  const ownSongs = ownSongsOf(snapshot, kept);

  const entries = downloads.flatMap((item): ReadonlyArray<DownloadedEntry> => {
    const { target } = item;

    return target.kind === "track" ? [] : [{ kind: "download", item: { ...item, target } }];
  });

  if (ownSongs.items.length > 0) entries.push({ kind: "songs", songs: ownSongs });

  return { downloads, entries, ownSongs, albums, playlists, songs, usage: snapshot.usage };
};
