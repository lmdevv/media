import {
  AlbumId,
  ArtistId,
  DeviceId,
  DownloadPinId,
  PlaylistId,
  TrackId,
} from "@music/commands/ids";
import type { DownloadPin, DownloadTarget, OfflineTrack } from "@music/commands/models";
import { describe, expect, it } from "vitest";

import { offlineLibrary } from "./library";
import { EMPTY_DOWNLOADS } from "./sync";
import type { DownloadsSnapshot, LocalCopy, PinView, TrackDownloadState } from "./sync";

const t1 = TrackId.make("t1");

const t2 = TrackId.make("t2");

const t3 = TrackId.make("t3");

const track = (id: TrackId): OfflineTrack => ({
  id,
  title: `Song ${id}`,
  artist: "Massive Attack",
  artistId: ArtistId.make("artist"),
  album: "Blue Lines",
  albumId: AlbumId.make("album"),
  trackNumber: 1,
  discNumber: 1,
  durationMs: 1000,
  codec: "AAC",
  lossless: false,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: null,
});

const copy = (id: TrackId, bytes: number, artUri: string | null = null): LocalCopy => ({
  track: track(id),
  uri: `file:///vault/${id}.m4a`,
  profile: "aac-320",
  bytes,
  artUri,
});

const pin = (target: DownloadTarget, artUrl: string | null = null): DownloadPin => ({
  id: DownloadPinId.make(`pin-${target.id}`),
  deviceId: DeviceId.make("phone"),
  target,
  createdAt: 1,
  available: true,
  title: `Title ${target.id}`,
  subtitle: "Massive Attack",
  artUrl,
  artHash: null,
});

const fetchable = (trackId: TrackId) => ({ trackId, state: "fetchable" }) as const;

const snapshot = (
  pins: ReadonlyArray<PinView>,
  copies: ReadonlyArray<LocalCopy>,
  tracks: ReadonlyArray<readonly [TrackId, TrackDownloadState]> = [],
): DownloadsSnapshot => ({
  ...EMPTY_DOWNLOADS,
  ready: true,
  online: true,
  pins,
  copies: new Map(copies.map((held) => [held.track.id, held])),
  tracks: new Map([...copies.map((held) => [held.track.id, "downloaded"] as const), ...tracks]),
});

const album = { kind: "album", id: AlbumId.make("album") } as const;

const playlist = { kind: "playlist", id: PlaylistId.make("late-night") } as const;

const song = { kind: "track", id: t3 } as const;

describe("offlineLibrary downloads", () => {
  it("lists each download with its songs, the space they take here, and its progress", () => {
    const { downloads } = offlineLibrary(
      snapshot(
        [{ pin: pin(album), members: [fetchable(t1), fetchable(t2)] }],
        [copy(t1, 400, "file:///vault/art/a.jpg")],
        [[t2, "downloading"]],
      ),
    );

    expect(downloads).toEqual([
      {
        target: album,
        title: "Title album",
        subtitle: "Massive Attack",
        songs: 2,
        bytes: 400,
        artUri: "file:///vault/art/a.jpg",
        status: { kind: "downloading", done: 1, total: 2 },
      },
    ]);
  });

  it("counts a single song by its own copy, and a playlist by its members", () => {
    const { downloads } = offlineLibrary(
      snapshot(
        [
          { pin: pin(playlist, "/media/art/cover"), members: [fetchable(t1), fetchable(t2)] },
          { pin: pin(song), members: [fetchable(t3)] },
        ],
        [copy(t1, 100, "file:///vault/art/a.jpg"), copy(t2, 200), copy(t3, 50)],
      ),
    );

    expect(
      downloads.map(({ target, songs, bytes, artUri, status }) => ({
        target,
        songs,
        bytes,
        artUri,
        status,
      })),
    ).toEqual([
      {
        target: playlist,
        songs: 2,
        bytes: 300,
        artUri: "/media/art/cover",
        status: { kind: "downloaded", bytes: 300 },
      },
      {
        target: song,
        songs: 1,
        bytes: 50,
        artUri: null,
        status: { kind: "downloaded", bytes: 50 },
      },
    ]);
  });

  it("knows no song count until the first manifest arrives", () => {
    const { downloads } = offlineLibrary(snapshot([{ pin: pin(album), members: null }], []));

    expect(downloads[0]?.songs).toBeNull();
    expect(downloads[0]?.status).toEqual({ kind: "queued" });
  });

  it("leaves out a download the server no longer lets this device read", () => {
    const gone: DownloadPin = {
      id: DownloadPinId.make("gone"),
      deviceId: DeviceId.make("phone"),
      target: album,
      createdAt: 1,
      available: false,
    };

    expect(offlineLibrary(snapshot([{ pin: gone, members: [] }], [])).downloads).toEqual([]);
  });
});
