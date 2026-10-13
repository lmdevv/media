import type {
  AlbumCard,
  ArtistCard,
  PlaybackState,
  SearchResults,
  Track,
} from "@music/commands/models";
import { commands } from "@music/commands/registry";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { choosePlay, describePlayback, livePosition, matchScore, PlayChoice } from "./shortcuts";

const decodeSearch = Schema.decodeSync(commands["search"].result);

const decodeState = Schema.decodeSync(commands["playback.state"].result);

const track = (id: string, title: string, artist: string): (typeof Track)["Encoded"] => ({
  id,
  title,
  artist,
  artistId: `ar-${artist}`,
  album: "Album",
  albumId: "al",
  trackNumber: 1,
  discNumber: 1,
  durationMs: 200_000,
  codec: "flac",
  lossless: true,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: null,
  liked: false,
});

const album = (id: string, title: string, artist: string): (typeof AlbumCard)["Encoded"] => ({
  id,
  title,
  artist,
  artistId: `ar-${artist}`,
  year: 2001,
  artUrl: null,
  trackCount: 14,
});

const artist = (id: string, name: string): (typeof ArtistCard)["Encoded"] => ({
  id,
  name,
  albumCount: 4,
  artUrl: null,
});

const results = (
  tracks: ReadonlyArray<(typeof Track)["Encoded"]>,
  albums: ReadonlyArray<(typeof AlbumCard)["Encoded"]>,
  artists: ReadonlyArray<(typeof ArtistCard)["Encoded"]>,
): SearchResults => decodeSearch({ tracks, albums, artists });

describe("matchScore", () => {
  it("ranks exact titles above prefixes above substrings", () => {
    expect(matchScore("Discovery", "Discovery", "Daft Punk")).toBe(5);
    // Folded like the server's search text, so what the server matched also ranks here.
    expect(matchScore("strasse", "Straße", null)).toBe(5);
    expect(matchScore("doppelganger", "Doppelgänger", null)).toBe(5);
    expect(matchScore("aeon", "Æon", null)).toBe(5);
    expect(matchScore("discovery daft punk", "Discovery", "Daft Punk")).toBe(5);
    expect(matchScore("Discovery by Daft Punk", "Discovery", "Daft Punk")).toBe(5);
    expect(matchScore("one more", "One More Time", "Daft Punk")).toBe(3);
    expect(matchScore("more time", "One More Time", "Daft Punk")).toBe(2);
    expect(matchScore("Beyoncé", "Beyonce", null)).toBe(5);
    expect(matchScore("unrelated", "Discovery", "Daft Punk")).toBe(0);
  });
});

describe("choosePlay", () => {
  it("plays an album when the query names it", () => {
    const choice = choosePlay(
      "Discovery",
      results(
        [track("t1", "Discovery Channel", "Someone")],
        [album("a1", "Discovery", "Daft Punk")],
        [],
      ),
    );

    expect(PlayChoice.$is("Album")(choice) ? choice.album.id : null).toBe("a1");
  });

  it("plays songs, best match first, when a song matches at least as well", () => {
    const choice = choosePlay(
      "One More Time",
      results(
        [track("t1", "Aerodynamic", "Daft Punk"), track("t2", "One More Time", "Daft Punk")],
        [album("a1", "One More Time (Remixes)", "Daft Punk")],
        [],
      ),
    );

    expect(PlayChoice.$is("Tracks")(choice) ? choice.tracks.map((item) => item.id) : []).toEqual([
      "t2",
      "t1",
    ]);
  });

  it("plays an artist's top songs when the artist matches best", () => {
    const choice = choosePlay(
      "daft punk",
      results([track("t1", "Around the World", "Daft Punk")], [], [artist("ar1", "Daft Punk")]),
    );

    expect(PlayChoice.$is("Artist")(choice) ? choice.artist.id : null).toBe("ar1");
  });

  it("returns null when nothing matched", () => {
    expect(choosePlay("anything", results([], [], []))).toBeNull();
  });
});

const state = (playing: boolean): PlaybackState =>
  decodeState({
    activeDevice: { id: "d1", name: "Kitchen", kind: "web", lastSeenAt: 0, online: true },
    queue: [track("t1", "Digital Love", "Daft Punk"), track("t2", "Voyager", "Daft Punk")],
    index: 0,
    positionMs: 30_000,
    playing,
    updatedAt: 1_000_000,
    shuffle: false,
    repeat: "all",
    volume: 0.8,
  });

describe("describePlayback", () => {
  it("advances the position while playing and caps it at the song length", () => {
    expect(livePosition(state(true), 1_010_000)).toBe(40_000);
    expect(livePosition(state(false), 1_010_000)).toBe(30_000);
    expect(livePosition(state(true), 9_000_000)).toBe(200_000);
  });

  it("summarizes the session", () => {
    expect(describePlayback(state(true), 1_010_000).split("\n")).toEqual([
      "▶ Digital Love — Daft Punk",
      "  Album · 0:40 / 3:20",
      "  on Kitchen (web) · 1 of 2 in queue · shuffle off · repeat all · volume 80%",
      "  track t1",
    ]);
  });
});
