import {
  AlbumId,
  ArtistId,
  DeviceId,
  DownloadPinId,
  PlaylistId,
  TrackId,
} from "@music/commands/ids";
import type { DownloadTarget } from "@music/commands/models";
import { EMPTY_DOWNLOADS, offlineLibrary } from "@music/sdk/downloads";
import type {
  DownloadedItem,
  DownloadsSnapshot,
  LocalCopy,
  PinView,
  TrackDownloadState,
} from "@music/sdk/downloads";
import { describe, expect, it } from "vitest";

import {
  downloadedDetail,
  downloadedEmpty,
  downloadedLine,
  downloadedNote,
  downloadedSummary,
  downloadsSettingsLine,
  entriesFor,
  onThisDevice,
  ownSongLine,
  ownSongsLine,
  ownSongsQueue,
  ownSongsSummary,
  removableSongs,
  storageLine,
} from "./downloaded";

const album: DownloadedItem = {
  target: { kind: "album", id: AlbumId.make("blue-lines") },
  title: "Blue Lines",
  subtitle: "Massive Attack",
  songs: 9,
  bytes: 412_000_000,
  freedBytes: 412_000_000,
  artUri: null,
  status: { kind: "downloaded", bytes: 412_000_000 },
};

const playlist: DownloadedItem = {
  target: { kind: "playlist", id: PlaylistId.make("late-night") },
  title: "Late night",
  subtitle: "Lee",
  songs: 24,
  bytes: 1_400_000_000,
  freedBytes: 1_400_000_000,
  artUri: null,
  status: { kind: "downloaded", bytes: 1_400_000_000 },
};

const song: DownloadedItem = {
  target: { kind: "track", id: TrackId.make("la-femme") },
  title: "La Femme d’Argent",
  subtitle: "Air",
  songs: 1,
  bytes: 54_000_000,
  freedBytes: 54_000_000,
  artUri: null,
  status: { kind: "downloaded", bytes: 54_000_000 },
};

const usage = { tracks: 55, bytes: 2_400_000_000, freeBytes: 41_000_000_000 };

describe("Downloaded", () => {
  it("words each finished download as Paper's D10 does", () => {
    expect(downloadedLine(album)).toEqual({
      text: "Album · Massive Attack",
      glyph: null,
      tone: "muted",
    });
    expect(downloadedLine(playlist).text).toBe("Playlist · 24 songs");
    expect(downloadedLine(song).text).toBe("Song · Air");
  });

  it("says where a download still coming stands, with its glyph", () => {
    expect(
      downloadedLine({ ...album, status: { kind: "downloading", done: 6, total: 10 } }),
    ).toEqual({
      text: "Downloading 6 of 10 · Massive Attack",
      glyph: "downloading",
      tone: "muted",
    });

    expect(downloadedLine({ ...album, status: { kind: "failed", failed: 2, total: 9 } })).toEqual({
      text: "Couldn’t download 2 of 9 · Massive Attack",
      glyph: "failed",
      tone: "danger",
    });

    expect(downloadedLine({ ...album, status: { kind: "queued" } }).glyph).toBe("queued");
  });

  it("sums up what the phone holds", () => {
    const all = [playlist, album, song];

    expect(downloadedSummary(usage, all)).toBe("55 SONGS · 1 ALBUM · 1 PLAYLIST");
    expect(downloadedNote(usage, "iPhone")).toBe(
      "Plays with no connection to your server. 41 GB still free on this iPhone.",
    );
    expect(downloadedNote(usage, "iPad")).toBe(
      "Plays with no connection to your server. 41 GB still free on this iPad.",
    );
    expect(downloadedNote({ ...usage, freeBytes: null }, "iPad")).toBe(
      "Plays with no connection to your server.",
    );
  });

  it("words the Settings row and the storage line", () => {
    expect(downloadsSettingsLine(usage)).toBe("2.4 GB · quality and storage");
    expect(downloadsSettingsLine({ tracks: 0, bytes: 0, freeBytes: null })).toBe(
      "Quality and storage",
    );
    expect(storageLine(usage)).toBe("55 songs · 2.4 GB");
    expect(storageLine({ tracks: 0, bytes: 0, freeBytes: null })).toBe("Nothing downloaded");
  });

  it("says what is missing when a filter holds nothing", () => {
    expect(downloadedEmpty("all", false).title).toBe("Nothing downloaded yet");
    expect(downloadedEmpty("albums", false).title).toBe("Nothing downloaded yet");
    expect(downloadedEmpty("albums", true)).toEqual({
      title: "No albums downloaded",
      body: "Download an album from its page\nto play it with no connection.",
    });
  });

  it("counts songs on the Library row only once there are some", () => {
    expect(downloadedDetail(usage, false)).toBe("55 songs");
    expect(downloadedDetail({ tracks: 0, bytes: 0, freeBytes: null }, false)).toBeNull();
  });

  it("gives the space on the Library row and the songs under its title while offline", () => {
    expect(downloadedDetail(usage, true)).toBe("2.4 GB");
    expect(downloadedDetail({ tracks: 0, bytes: 0, freeBytes: null }, true)).toBeNull();
    expect(onThisDevice(usage, "iPhone")).toBe("55 songs on this iPhone");
    expect(onThisDevice({ ...usage, tracks: 1 }, "iPhone")).toBe("1 song on this iPhone");
    expect(onThisDevice(usage, "iPad")).toBe("55 songs on this iPad");
  });
});

const t1 = TrackId.make("unfinished-sympathy");

const t2 = TrackId.make("la-femme");

const t3 = TrackId.make("sexy-boy");

const blueLines = { kind: "album", id: AlbumId.make("blue-lines") } as const;

const copyOf = (id: TrackId, bytes: number): LocalCopy => ({
  track: {
    id,
    title: id,
    artist: "Air",
    artistId: ArtistId.make("air"),
    album: "Moon Safari",
    albumId: AlbumId.make("moon-safari"),
    trackNumber: 1,
    discNumber: 1,
    durationMs: 1000,
    codec: "AAC",
    lossless: false,
    bitrate: null,
    sampleRate: null,
    bitDepth: null,
    artUrl: null,
  },
  uri: `file:///vault/${id}.m4a`,
  profile: "aac-320",
  bytes,
  artUri: null,
});

const pinOf = (target: DownloadTarget, members: ReadonlyArray<TrackId>): PinView => ({
  pin: {
    id: DownloadPinId.make(`pin-${target.id}`),
    deviceId: DeviceId.make("phone"),
    target,
    createdAt: 1,
    available: true,
    title: target.kind === "album" ? "Blue Lines" : target.id,
    subtitle: "Air",
    artUrl: null,
    artHash: null,
  },
  members: members.map((trackId) => ({ trackId, state: "fetchable" })),
});

const ownSong = (id: TrackId): PinView => pinOf({ kind: "track", id }, [id]);

const phone = (
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
  usage: {
    tracks: copies.length,
    bytes: copies.reduce((total, held) => total + held.bytes, 0),
    freeBytes: null,
  },
});

const rows = (entries: ReturnType<typeof entriesFor>): ReadonlyArray<string> =>
  entries.map((entry) => (entry.kind === "songs" ? "Songs" : entry.item.title));

describe("Downloaded's Songs row", () => {
  it("shows a song its album also holds only inside that album", () => {
    const library = offlineLibrary(
      phone([ownSong(t1), pinOf(blueLines, [t1, t2])], [copyOf(t1, 100), copyOf(t2, 200)]),
    );

    expect(rows(entriesFor("all", library.entries))).toEqual(["Blue Lines"]);
    expect(downloadedSummary(library.usage, library.downloads)).toBe(
      "2 SONGS · 1 ALBUM · 0 PLAYLISTS",
    );
  });

  it("lists the song in the Songs row again once its album is removed", () => {
    const library = offlineLibrary(phone([ownSong(t1)], [copyOf(t1, 100)]));

    expect(rows(entriesFor("all", library.entries))).toEqual(["Songs"]);
    expect(ownSongsLine(library.ownSongs)).toEqual({ text: "1 song", glyph: null, tone: "muted" });
    expect(ownSongsSummary(library.ownSongs)).toBe("1 SONG");
  });

  it("keeps the Songs row out of the Albums and Playlists filters", () => {
    const library = offlineLibrary(
      phone([ownSong(t3), pinOf(blueLines, [t1])], [copyOf(t1, 100), copyOf(t3, 50)]),
    );

    expect(rows(entriesFor("all", library.entries))).toEqual(["Blue Lines", "Songs"]);
    expect(rows(entriesFor("albums", library.entries))).toEqual(["Blue Lines"]);
    expect(rows(entriesFor("playlists", library.entries))).toEqual([]);
  });

  it("lets the Songs chip remove only songs downloaded on their own", () => {
    const library = offlineLibrary(
      phone(
        [ownSong(t1), pinOf(blueLines, [t1, t2]), ownSong(t3)],
        [copyOf(t1, 100), copyOf(t2, 200), copyOf(t3, 50)],
      ),
    );

    const removable = removableSongs(library.downloads);

    expect(library.songs.map((copy) => removable.has(copy.track.id))).toEqual(
      library.songs.map((copy) => copy.track.id !== t2),
    );
  });

  it("says the Songs row failed once its songs still to come failed", () => {
    const library = offlineLibrary(
      phone([ownSong(t2), ownSong(t3)], [copyOf(t2, 100)], [[t3, "failed"]]),
    );

    expect(ownSongsLine(library.ownSongs)).toEqual({
      text: "Couldn’t download 1 of 2",
      glyph: "failed",
      tone: "danger",
    });
  });

  it("says how far the Songs row got while songs are coming", () => {
    const library = offlineLibrary(
      phone([ownSong(t2), ownSong(t3)], [copyOf(t2, 100)], [[t3, "downloading"]]),
    );

    expect(ownSongsLine(library.ownSongs)).toEqual({
      text: "Downloading 1 of 2",
      glyph: "downloading",
      tone: "muted",
    });
  });

  it("plays the songs on the phone from a tap, and a song still coming on its own", () => {
    const library = offlineLibrary(
      phone([ownSong(t1), ownSong(t2), ownSong(t3)], [copyOf(t1, 100), copyOf(t3, 50)]),
    );

    const { items } = library.ownSongs;

    expect(items.map((tapped) => ownSongsQueue(items, tapped))).toEqual([
      { trackIds: [t1, t3], index: 0 },
      { trackIds: [t2], index: 0 },
      { trackIds: [t1, t3], index: 1 },
    ]);
  });

  it("words each song on the Songs page by its artist, or where it stands", () => {
    const own = { ...song, target: { kind: "track", id: TrackId.make("la-femme") } } as const;

    expect(ownSongLine(own).text).toBe("Air");
    expect(ownSongLine({ ...own, status: { kind: "queued" } })).toEqual({
      text: "Waiting to download · Air",
      glyph: "queued",
      tone: "muted",
    });
  });
});
