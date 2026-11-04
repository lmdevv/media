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

import { freedBytesOf, offlineLibrary } from "./library";
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
        freedBytes: 400,
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

const ownSong = (id: TrackId): PinView => ({
  pin: pin({ kind: "track", id }),
  members: [fetchable(id)],
});

const albumOf = (...ids: ReadonlyArray<TrackId>): PinView => ({
  pin: pin(album),
  members: ids.map(fetchable),
});

describe("offlineLibrary songs downloaded on their own", () => {
  it("lists a song its album also holds once, inside that album", () => {
    const library = offlineLibrary(
      snapshot([ownSong(t1), albumOf(t1, t2)], [copy(t1, 100), copy(t2, 200)]),
    );

    expect(library.entries.map((entry) => entry.kind)).toEqual(["download"]);
    expect(library.ownSongs.items).toEqual([]);
    expect(library.downloads.map(({ target }) => target.kind)).toEqual(["track", "album"]);
  });

  it("brings the song back to the group once its album is removed", () => {
    const library = offlineLibrary(snapshot([ownSong(t1)], [copy(t1, 100)]));

    expect(library.entries).toEqual([{ kind: "songs", songs: library.ownSongs }]);
    expect(library.ownSongs.items.map(({ target }) => target.id)).toEqual([t1]);
    expect(library.ownSongs.status).toEqual({ kind: "downloaded", bytes: 100 });
  });

  it("groups every song of its own into one row after the albums and playlists", () => {
    const library = offlineLibrary(
      snapshot(
        [ownSong(t3), { pin: pin(playlist), members: [fetchable(t1)] }, ownSong(t2)],
        [copy(t1, 100), copy(t2, 200, "file:///vault/art/b.jpg"), copy(t3, 50)],
      ),
    );

    expect(
      library.entries.map((entry) => (entry.kind === "songs" ? "songs" : entry.item.target.kind)),
    ).toEqual(["playlist", "songs"]);
    expect(library.ownSongs).toMatchObject({ bytes: 250, artUri: "file:///vault/art/b.jpg" });
    expect(library.ownSongs.items.map(({ target }) => target.id)).toEqual([t3, t2]);
  });

  it("frees only the songs no other download keeps", () => {
    const shared = offlineLibrary(
      snapshot([ownSong(t1), albumOf(t1, t2)], [copy(t1, 100), copy(t2, 200)]),
    );

    expect(shared.downloads.map(({ bytes, freedBytes }) => ({ bytes, freedBytes }))).toEqual([
      { bytes: 100, freedBytes: 0 },
      { bytes: 300, freedBytes: 200 },
    ]);

    const alone = offlineLibrary(snapshot([ownSong(t1)], [copy(t1, 100)]));

    expect(alone.downloads[0]?.freedBytes).toBe(100);
  });

  it("counts a song as kept only by downloads that list it, as syncing does", () => {
    const view = snapshot(
      [{ pin: pin({ kind: "track", id: t1 }), members: null }, albumOf(t1, t2)],
      [copy(t1, 100), copy(t2, 200)],
    );

    expect(offlineLibrary(view).downloads.map(({ freedBytes }) => freedBytes)).toEqual([0, 300]);
    expect(freedBytesOf(view, album)).toBe(300);
    expect(freedBytesOf(view, { kind: "track", id: t2 })).toBe(0);
  });

  it("says the group failed once every song still to come failed", () => {
    const library = offlineLibrary(
      snapshot([ownSong(t1), ownSong(t2)], [copy(t1, 100)], [[t2, "failed"]]),
    );

    expect(library.ownSongs.status).toEqual({ kind: "failed", failed: 1, total: 2 });
  });

  it("counts a song with no manifest yet as one still to come", () => {
    const library = offlineLibrary(
      snapshot(
        [ownSong(t1), { pin: pin({ kind: "track", id: t2 }), members: null }],
        [copy(t1, 100)],
      ),
    );

    expect(library.ownSongs.status).toEqual({ kind: "downloading", done: 1, total: 2 });
  });
});
