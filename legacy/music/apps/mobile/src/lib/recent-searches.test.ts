import { describe, expect, it } from "vitest";

import {
  MAX_STORED_BYTES,
  decodeRecents,
  encodeRecents,
  recentAlbum,
  recentArtist,
  recentKey,
  recentTrack,
  rememberRecent,
} from "./recent-searches";
import { albumOf, artistOf, trackOf } from "./test-fixtures";

/** A song whose snapshot is long enough that eight of them outgrow a keychain value. */
const long = (index: number) =>
  recentTrack(trackOf(`${"Long title ".repeat(12)}${String(index)}`, "Somebody", "x".repeat(80)));

describe("rememberRecent", () => {
  it("puts the newest first and lists a result once", () => {
    const angel = recentTrack(trackOf("Angel"));
    const mezzanine = recentAlbum(albumOf("Mezzanine"));

    const recents = rememberRecent(rememberRecent(rememberRecent([], angel), mezzanine), angel);

    expect(recents.map(recentKey)).toEqual([recentKey(angel), recentKey(mezzanine)]);
  });

  it("keeps at most eight", () => {
    const recents = Array.from({ length: 12 }, (_, index) =>
      recentArtist(artistOf(`Artist ${String(index)}`)),
    ).reduce(rememberRecent, []);

    expect(recents).toHaveLength(8);
    expect(recents[0]).toMatchObject({ name: "Artist 11" });
  });

  it("drops the oldest entries rather than outgrow a keychain value", () => {
    const recents = Array.from({ length: 8 }, (_, index) => long(index)).reduce(rememberRecent, []);

    expect(new TextEncoder().encode(encodeRecents(recents)).length).toBeLessThanOrEqual(
      MAX_STORED_BYTES,
    );
    expect(recents.length).toBeLessThan(8);
    expect(recents.map(recentKey)[0]).toBe(recentKey(long(7)));
  });
});

describe("decodeRecents", () => {
  it("round-trips the stored list and forgets one that no longer parses", () => {
    const recents = [recentTrack(trackOf("Roads", "Portishead")), recentArtist(artistOf("Air"))];

    expect(decodeRecents(encodeRecents(recents))).toEqual(recents);
    expect(decodeRecents(null)).toEqual([]);
    expect(decodeRecents('[{"kind":"playlist"}]')).toEqual([]);
  });
});
