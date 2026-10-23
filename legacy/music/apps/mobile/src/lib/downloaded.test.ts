import { AlbumId, PlaylistId, TrackId } from "@music/commands/ids";
import type { DownloadedItem } from "@music/sdk/downloads";
import { describe, expect, it } from "vitest";

import {
  downloadedCount,
  downloadedEmpty,
  downloadedLine,
  downloadedNote,
  downloadedSummary,
  downloadsFor,
  downloadsSettingsLine,
  storageLine,
} from "./downloaded";

const album: DownloadedItem = {
  target: { kind: "album", id: AlbumId.make("blue-lines") },
  title: "Blue Lines",
  subtitle: "Massive Attack",
  songs: 9,
  bytes: 412_000_000,
  artUri: null,
  status: { kind: "downloaded", bytes: 412_000_000 },
};

const playlist: DownloadedItem = {
  target: { kind: "playlist", id: PlaylistId.make("late-night") },
  title: "Late night",
  subtitle: "Lee",
  songs: 24,
  bytes: 1_400_000_000,
  artUri: null,
  status: { kind: "downloaded", bytes: 1_400_000_000 },
};

const song: DownloadedItem = {
  target: { kind: "track", id: TrackId.make("la-femme") },
  title: "La Femme d’Argent",
  subtitle: "Air",
  songs: 1,
  bytes: 54_000_000,
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

  it("filters by kind and sums up what the phone holds", () => {
    const all = [playlist, album, song];

    expect(downloadsFor("all", all)).toEqual(all);
    expect(downloadsFor("albums", all)).toEqual([album]);
    expect(downloadsFor("playlists", all)).toEqual([playlist]);
    expect(downloadedSummary(usage, all)).toBe("55 SONGS · 1 ALBUM · 1 PLAYLIST");
    expect(downloadedNote(usage)).toBe(
      "Plays with no connection to your server. 41 GB still free on this iPhone.",
    );
    expect(downloadedNote({ ...usage, freeBytes: null })).toBe(
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
    expect(downloadedCount(usage)).toBe("55 songs");
    expect(downloadedCount({ tracks: 0, bytes: 0, freeBytes: null })).toBeNull();
  });
});
