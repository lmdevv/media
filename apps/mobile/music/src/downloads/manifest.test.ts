import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { creditText } from "@/lib/credits";
import { asArtistId, asPlaylistId, asUserId } from "@/lib/models";
import type { Playlist, PlaylistEntry } from "@/lib/models";
import { albumOf, trackOf } from "@/lib/test-fixtures";

import { manifestOf } from "./manifest";
import type { CoreKept } from "./manifest";
import { pinIdOf, UNKNOWN_REVISION } from "./sync/plan";
import type { DownloadPin } from "./sync/models";

const album = albumOf("Blue Lines");

const pin: DownloadPin = {
  id: pinIdOf({ kind: "album", id: album.id }),
  target: { kind: "album", id: album.id },
  createdAt: 1,
  available: true,
  title: "",
  subtitle: "",
  artUrl: null,
  artHash: null,
};

type KeptRow = CoreKept extends ReadonlyMap<string, infer Row> ? Row : never;

const kept = (rows: ReadonlyArray<readonly [string, KeptRow]>): CoreKept => new Map(rows);

const available = (id: string, revision: string): KeptRow => ({
  item: { kind: "track", id: trackOf(id).id },
  state: "available",
  revision,
  extrasRevision: null,
  quality: "standard",
  bytes: 1,
  label: id,
});

describe("manifestOf", () => {
  it("names the album and lists its songs at the core's revision, unknown before it keeps one", () => {
    const one = trackOf("Safe from Harm");
    const two = trackOf("One Love");

    const manifest = manifestOf(
      pin,
      { kind: "album", album, tracks: [one, two, one] },
      kept([[one.id, available("Safe from Harm", "r1")]]),
    );

    expect(manifest.pin).toMatchObject({
      available: true,
      title: "Blue Lines",
      subtitle: "Massive Attack",
      artHash: "Blue",
    });
    expect(manifest.entries.map((entry) => [entry.track.title, entry.rev])).toEqual([
      ["Safe from Harm", "r1"],
      ["One Love", UNKNOWN_REVISION],
    ]);
    expect(manifest.entries[0]?.track).not.toHaveProperty("liked");
  });

  it("keeps a song's credits and names a song download by every artist it credits", () => {
    const mora = asArtistId("ar-Mora");

    const song = {
      ...trackOf("TOA (feat. Young Miko)", "Mora"),
      artistId: mora,
      credits: [
        { artistId: mora, name: "Mora" },
        { artistId: asArtistId("ar-Young Miko"), name: "Young Miko" },
      ],
    };

    const songPin: DownloadPin = { ...pin, target: { kind: "track", id: song.id } };
    const manifest = manifestOf(songPin, { kind: "track", track: song }, kept([]));

    expect(manifest.entries[0]?.track.credits).toEqual(song.credits);
    expect(manifest.pin).toMatchObject({ subtitle: creditText(song) });
    expect(creditText(song)).toContain("Young Miko");
  });

  it("leaves out a song the core says expired here or is gone", () => {
    const one = trackOf("Safe from Harm");

    const manifest = manifestOf(
      pin,
      { kind: "album", album, tracks: [one] },
      kept([[one.id, { item: { kind: "track", id: one.id }, state: "gone" }]]),
    );

    expect(manifest.entries).toEqual([]);
  });

  it("keeps a playlist's songs you may play, and marks a download unavailable once its target is", () => {
    const one = trackOf("Safe from Harm");
    const asItem = Brand.nominal<PlaylistEntry["itemId"]>();

    const entry = (track: typeof one | null, open: boolean): PlaylistEntry => ({
      itemId: asItem(track?.id ?? "withheld"),
      addedAt: 1,
      track,
      durationMs: 1,
      available: open,
      reason: open ? null : "no_access",
      addedBy: null,
    });

    const playlist: Playlist = {
      id: asPlaylistId("mix"),
      name: "Mix",
      description: null,
      trackCount: 2,
      durationMs: 2,
      artUrls: [],
      updatedAt: 1,
      owner: { id: asUserId("aiko"), name: "Aiko" },
      visibility: "private",
      sharedWithPeople: false,
      access: "owner",
    };

    const manifest = manifestOf(
      pin,
      { kind: "playlist", playlist, entries: [entry(one, true), entry(null, false)] },
      kept([]),
    );

    expect(manifest.pin).toMatchObject({ title: "Mix", subtitle: "Aiko" });
    expect(manifest.entries).toHaveLength(1);
    expect(manifestOf(pin, { kind: "unavailable" }, kept([])).pin.available).toBe(false);
  });
});
