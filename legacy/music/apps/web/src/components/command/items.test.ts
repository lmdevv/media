import { fieldsOf } from "@music/commands/forms";
import { AlbumCard, ArtistCard, Playlist, Track } from "@music/commands/models";
import { Schema } from "effect";
import { HeartIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

import { browseItems, cliOf, primaryLabel, searchItems, titleOf } from "./items";
import type { Item } from "./items";

const track = (id: string, title: string): Track =>
  Schema.decodeSync(Track)({
    id,
    title,
    artist: "Nina Simone",
    artistId: "ar1",
    album: "Pastel Blues",
    albumId: "al1",
    trackNumber: 1,
    discNumber: 1,
    durationMs: 600_000,
    codec: "flac",
    lossless: true,
    bitrate: null,
    sampleRate: 44_100,
    bitDepth: 16,
    artUrl: null,
    liked: false,
  });

const album = (id: string, title: string): AlbumCard =>
  Schema.decodeSync(AlbumCard)({
    id,
    title,
    artist: "Nina Simone",
    artistId: "ar1",
    year: 1965,
    artUrl: null,
    trackCount: 9,
  });

const artist = (id: string, name: string): ArtistCard =>
  Schema.decodeSync(ArtistCard)({ id, name, albumCount: 3, artUrl: null });

const playlist = (id: string, name: string): Playlist =>
  Schema.decodeSync(Playlist)({
    id,
    name,
    description: null,
    trackCount: 2,
    durationMs: 300_000,
    artUrls: [],
    updatedAt: 0,
    owner: null,
    visibility: "private",
    sharedWithPeople: false,
    access: "owner",
  });

const action = (id: string, title: string, detail: string): Item => ({
  kind: "action",
  id,
  section: "Commands",
  title,
  detail,
  icon: HeartIcon,
  label: "Open",
  run: () => undefined,
});

const command = (name: "playlists.create"): Item => ({
  kind: "command",
  id: `cmd-${name}`,
  section: "Commands",
  name,
  fields: fieldsOf(name) ?? [],
});

const ids = (items: ReadonlyArray<Item>) => items.map((item) => item.id);

describe("cliOf", () => {
  it("spells a command the way the CLI takes it", () => {
    expect(cliOf("playlists.create")).toBe("music playlists create");
    expect(cliOf("search")).toBe("music search");
  });
});

describe("titleOf and primaryLabel", () => {
  it("names each kind of row and what Enter does to it", () => {
    const song = track("t1", "Sinnerman");

    expect(titleOf({ kind: "now", id: "now", section: "Now playing", track: song })).toBe(
      "Sinnerman",
    );
    expect(titleOf({ kind: "artist", id: "ar", section: "", artist: artist("ar1", "Nina") })).toBe(
      "Nina",
    );
    expect(primaryLabel({ kind: "now", id: "now", section: "", track: song }, true)).toBe("Pause");
    expect(primaryLabel({ kind: "now", id: "now", section: "", track: song }, false)).toBe(
      "Resume",
    );
    expect(primaryLabel(command("playlists.create"), false)).toBe("Run");
    expect(primaryLabel(action("a", "Shuffle liked songs", ""), false)).toBe("Open");
  });
});

describe("browseItems", () => {
  const actions = [action("devices", "Play on another device…", "Move playback")];

  it("leads with the song playing, then two recent playlists and albums, then the actions", () => {
    const items = browseItems({
      track: track("t1", "Sinnerman"),
      playlists: [playlist("p1", "Mix"), playlist("p2", "Focus"), playlist("p3", "Runs")],
      recentlyPlayed: [album("a1", "Pastel Blues"), album("a2", "Wild"), album("a3", "Silk")],
      actions,
    });

    expect(ids(items)).toEqual(["now", "pl-p1", "pl-p2", "al-a1", "al-a2", "devices"]);
    expect(items.map((item) => item.section)).toEqual([
      "Now playing",
      "Recent",
      "Recent",
      "Recent",
      "Recent",
      "Commands",
    ]);
  });

  it("has no now-playing row when nothing is loaded", () => {
    expect(ids(browseItems({ track: null, playlists: [], recentlyPlayed: [], actions }))).toEqual([
      "devices",
    ]);
  });
});

describe("searchItems", () => {
  const actions = [
    action("devices", "Play on another device…", "Move playback to your phone or a speaker"),
    action("new-playlist", "New playlist", "Create a playlist"),
    action("go-playlists", "Playlists", "Open Playlists"),
    command("playlists.create"),
  ];

  it("caps library results per kind and keeps the whole result list for each song", () => {
    const tracks = [1, 2, 3, 4, 5].map((n) => track(`t${n}`, `Song ${n}`));

    const items = searchItems({
      query: "zzz",
      results: {
        artists: [artist("r1", "A"), artist("r2", "B"), artist("r3", "C")],
        albums: [1, 2, 3, 4].map((n) => album(`a${n}`, `Album ${n}`)),
        tracks,
      },
      playlists: [],
      actions,
    });

    expect(ids(items)).toEqual([
      "ar-r1",
      "ar-r2",
      "al-a1",
      "al-a2",
      "al-a3",
      "tr-t1",
      "tr-t2",
      "tr-t3",
      "tr-t4",
    ]);
    expect(items.every((item) => item.section === "Top results")).toBe(true);

    const [, , , , , first] = items;
    expect(first?.kind === "track" ? first.tracks : null).toEqual(tracks);
  });

  it("matches playlists by name, ignoring accents and case", () => {
    const items = searchItems({
      query: "cafe",
      results: { artists: [], albums: [], tracks: [] },
      playlists: [playlist("p1", "Café Mornings"), playlist("p2", "Runs")],
      actions: [],
    });

    expect(ids(items)).toEqual(["pl-p1"]);
  });

  it("shows only matching actions while library results load", () => {
    const items = searchItems({ query: "speaker", results: undefined, playlists: [], actions });

    // "speaker" is only in the devices action's detail.
    expect(ids(items)).toEqual(["devices"]);
  });

  it("ranks a title prefix over a word prefix over a match anywhere", () => {
    const items = searchItems({ query: "pla", results: undefined, playlists: [], actions });

    // "Play on another device…" and "Playlists" start with the query; "New playlist" and the
    // command's "Create a playlist" only have a word that does. Ties keep their order.
    expect(ids(items)).toEqual(["devices", "go-playlists", "new-playlist", "cmd-playlists.create"]);
  });

  it("needs every word of the query somewhere in the title or keywords", () => {
    expect(
      ids(searchItems({ query: "music playlists", results: undefined, playlists: [], actions })),
    ).toEqual(["cmd-playlists.create"]);
    expect(
      ids(searchItems({ query: "new speaker", results: undefined, playlists: [], actions })),
    ).toEqual([]);
  });
});
