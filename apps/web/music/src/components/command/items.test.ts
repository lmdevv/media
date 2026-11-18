import { HeartIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

import { asAlbumId, asArtistId, asPlaylistId, asTrackId } from "@/lib/models";
import type { AlbumCard, ArtistCard, Playlist, Track } from "@/lib/models";

import { browseItems, searchItems, titleOf } from "./items";
import type { Item } from "./items";

const track = (id: string, title: string): Track => ({
  id: asTrackId(id),
  title,
  artist: "Nina Simone",
  artistId: asArtistId("ar1"),
  album: "Pastel Blues",
  albumId: asAlbumId("al1"),
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

const album = (id: string, title: string): AlbumCard => ({
  id: asAlbumId(id),
  title,
  artist: "Nina Simone",
  artistId: asArtistId("ar1"),
  year: 1965,
  artUrl: null,
  trackCount: 9,
});

const artist = (id: string, name: string): ArtistCard => ({
  id: asArtistId(id),
  name,
  albumCount: 3,
  artUrl: null,
});

const playlist = (id: string, name: string): Playlist => ({
  id: asPlaylistId(id),
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

const ids = (items: ReadonlyArray<Item>) => items.map((item) => item.id);

describe("titleOf", () => {
  it("names each kind of row", () => {
    const song = track("t1", "Sinnerman");

    expect(titleOf({ kind: "now", id: "now", section: "Now playing", track: song })).toBe(
      "Sinnerman",
    );
    expect(titleOf({ kind: "artist", id: "ar", section: "", artist: artist("ar1", "Nina") })).toBe(
      "Nina",
    );
    expect(titleOf(action("a", "Shuffle liked songs", ""))).toBe("Shuffle liked songs");
  });
});

describe("browseItems", () => {
  const actions = [action("open-queue", "Open the queue", "See and change what plays next")];

  it("leads with the song playing, then two recent playlists and albums, then the actions", () => {
    const items = browseItems({
      track: track("t1", "Sinnerman"),
      playlists: [playlist("p1", "Mix"), playlist("p2", "Focus"), playlist("p3", "Runs")],
      recentlyPlayed: [album("a1", "Pastel Blues"), album("a2", "Wild"), album("a3", "Silk")],
      actions,
    });

    expect(ids(items)).toEqual(["now", "pl-p1", "pl-p2", "al-a1", "al-a2", "open-queue"]);
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
      "open-queue",
    ]);
  });
});

describe("searchItems", () => {
  const actions = [
    action("open-queue", "Open the queue", "See and change what plays next in the queue"),
    action("new-playlist", "New playlist", "Create a playlist"),
    action("go-playlists", "Playlists", "Open Playlists"),
    action("shuffle-liked", "Shuffle liked songs", "Play your liked songs in random order"),
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
    const items = searchItems({ query: "queue", results: undefined, playlists: [], actions });

    expect(ids(items)).toEqual(["open-queue"]);
  });

  it("ranks a title prefix over a word prefix over a match anywhere", () => {
    const items = searchItems({ query: "pla", results: undefined, playlists: [], actions });

    expect(ids(items)).toEqual(["go-playlists", "new-playlist", "open-queue", "shuffle-liked"]);
  });

  it("finds an action by its hidden keywords without showing them", () => {
    const songs: Item = {
      kind: "action",
      id: "go-tracks.list",
      section: "Go to",
      title: "Songs",
      detail: "Open Songs",
      keywords: "tracks.list",
      icon: HeartIcon,
      label: "Open",
      run: () => undefined,
    };

    expect(
      ids(searchItems({ query: "tracks", results: undefined, playlists: [], actions: [songs] })),
    ).toEqual(["go-tracks.list"]);
  });

  it("needs every word of the query somewhere in the title or keywords", () => {
    expect(
      ids(searchItems({ query: "liked random", results: undefined, playlists: [], actions })),
    ).toEqual(["shuffle-liked"]);
    expect(
      ids(searchItems({ query: "new queue", results: undefined, playlists: [], actions })),
    ).toEqual([]);
  });
});
