import type { PlatformSdk } from "@media/sdk/promise";

import type { AlbumCard, Playlist, PlaylistEntry, Track } from "@/lib/models";

import type { DownloadManifest, DownloadPin, ManifestEntry, OfflineTrack } from "./sync/models";
import { artHashOf, UNKNOWN_REVISION } from "./sync/plan";

type KeptRow = Awaited<ReturnType<PlatformSdk["core"]["downloads"]["list"]>>["page"][number];

/** The songs the core keeps on this device, by song id, as `core.downloads.list` lists them. */
export type CoreKept = ReadonlyMap<string, KeptRow>;

/** What the core says a download holds now. */
export type PinRead =
  | { readonly kind: "track"; readonly track: Track }
  | { readonly kind: "album"; readonly album: AlbumCard; readonly tracks: ReadonlyArray<Track> }
  | {
      readonly kind: "playlist";
      readonly playlist: Playlist;
      readonly entries: ReadonlyArray<PlaylistEntry>;
    }
  /** The song, album, or playlist is gone, or no longer yours to read. */
  | { readonly kind: "unavailable" };

/** A song as a download keeps it: without `liked`, so a like never changes a manifest. */
const offlineTrackOf = (track: Track): OfflineTrack => ({
  id: track.id,
  title: track.title,
  artist: track.artist,
  artistId: track.artistId,
  album: track.album,
  albumId: track.albumId,
  trackNumber: track.trackNumber,
  discNumber: track.discNumber,
  durationMs: track.durationMs,
  codec: track.codec,
  lossless: track.lossless,
  bitrate: track.bitrate,
  sampleRate: track.sampleRate,
  bitDepth: track.bitDepth,
  artUrl: track.artUrl,
});

/**
 * One song of a download, as the core keeps it on this device: fetchable at the revision the core
 * names, or at an unknown one before the core lists it; missing once the core says it expired
 * here or is gone, so the copy is deleted.
 */
const entryOf = (track: Track, kept: CoreKept): ManifestEntry | null => {
  const row = kept.get(track.id);

  if (row !== undefined && row.state !== "available") return null;

  return {
    track: offlineTrackOf(track),
    rev: row === undefined ? UNKNOWN_REVISION : row.revision,
    artHash: artHashOf(track.artUrl),
    state: "fetchable",
  };
};

const entriesOf = (tracks: ReadonlyArray<Track>, kept: CoreKept): ReadonlyArray<ManifestEntry> => {
  const seen = new Set<string>();

  return tracks.flatMap((track) => {
    if (seen.has(track.id)) return [];
    seen.add(track.id);
    const entry = entryOf(track, kept);

    return entry === null ? [] : [entry];
  });
};

/**
 * What a download holds now, as old music's `downloads.manifest` answered it: the pin with the
 * details the core gives, and its songs in album or playlist order. A playlist's songs you may not
 * play, or whose file is gone, are left out, as are songs the core no longer serves this device.
 */
export const manifestOf = (pin: DownloadPin, read: PinRead, kept: CoreKept): DownloadManifest => {
  const base = { id: pin.id, target: pin.target, createdAt: pin.createdAt };

  if (read.kind === "unavailable") return { pin: { ...base, available: false }, entries: [] };

  if (read.kind === "track") {
    return {
      pin: {
        ...base,
        available: true,
        title: read.track.title,
        subtitle: read.track.artist,
        artUrl: read.track.artUrl,
        artHash: artHashOf(read.track.artUrl),
      },
      entries: entriesOf([read.track], kept),
    };
  }

  if (read.kind === "album") {
    return {
      pin: {
        ...base,
        available: true,
        title: read.album.title,
        subtitle: read.album.artist,
        artUrl: read.album.artUrl,
        artHash: artHashOf(read.album.artUrl),
      },
      entries: entriesOf(read.tracks, kept),
    };
  }

  const cover = read.playlist.artUrls[0] ?? null;

  return {
    pin: {
      ...base,
      available: true,
      title: read.playlist.name,
      subtitle: read.playlist.owner?.name ?? "",
      artUrl: cover,
      artHash: artHashOf(cover),
    },
    entries: entriesOf(
      read.entries.flatMap((entry) =>
        entry.track === null || !entry.available ? [] : [entry.track],
      ),
      kept,
    ),
  };
};
