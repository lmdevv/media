import { AlbumId, DeviceId, DownloadPinId, PlaylistId } from "@music/commands/ids";
import type { LocalCopy, OfflineLibrary } from "@music/sdk/downloads";
import { describe, expect, it } from "vitest";

import { offlineAlbum, offlinePlaylist } from "./offline-library";
import { trackOf } from "./test-fixtures";

const copyOf = (title: string, artUri: string | null): LocalCopy => ({
  track: trackOf(title, "Massive Attack", "Blue Lines"),
  uri: `file:///vault/${title}.m4a`,
  profile: "aac-320",
  bytes: 8_000_000,
  artUri,
});

const safeFromHarm = copyOf("Safe from Harm", null);

const unfinished = copyOf("Unfinished Sympathy", "file:///vault/art/blue-lines.jpg");

const lateNight = PlaylistId.make("late-night");

const library: Pick<OfflineLibrary, "albums" | "playlists"> = {
  albums: [
    {
      albumId: AlbumId.make("al-Blue Lines"),
      title: "Blue Lines",
      artist: "Massive Attack",
      artUri: "file:///vault/art/blue-lines.jpg",
      tracks: [safeFromHarm, unfinished],
    },
  ],
  playlists: [
    {
      pin: {
        id: DownloadPinId.make("pin-late-night"),
        deviceId: DeviceId.make("phone"),
        target: { kind: "playlist", id: lateNight },
        createdAt: 1,
        available: true,
        title: "Late night",
        subtitle: "Lee",
        artUrl: "/media/art/signed-cover",
        artHash: null,
      },
      tracks: [safeFromHarm, unfinished],
    },
  ],
};

describe("offline library pages", () => {
  it("opens a downloaded album with the songs this phone holds", () => {
    expect(offlineAlbum(library, AlbumId.make("al-Blue Lines"))).toEqual({
      title: "Blue Lines",
      subtitle: "Massive Attack",
      artUri: "file:///vault/art/blue-lines.jpg",
      tracks: [safeFromHarm, unfinished],
    });
  });

  it("finds no album this phone holds none of", () => {
    expect(offlineAlbum(library, AlbumId.make("al-Dummy"))).toBeNull();
  });

  it("opens a downloaded playlist under its owner, with a cover from this phone", () => {
    expect(offlinePlaylist(library, lateNight)).toEqual({
      title: "Late night",
      subtitle: "Lee",
      artUri: "file:///vault/art/blue-lines.jpg",
      tracks: [safeFromHarm, unfinished],
    });
  });

  it("falls back to the server's cover when no song here has one", () => {
    const bare = library.playlists.map((held) => ({ ...held, tracks: [safeFromHarm] }));

    expect(offlinePlaylist({ playlists: bare }, lateNight)?.artUri).toBe("/media/art/signed-cover");
  });

  it("finds no playlist that isn't downloaded", () => {
    expect(offlinePlaylist(library, PlaylistId.make("road-trip"))).toBeNull();
  });
});
