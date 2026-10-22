import { describe, expect, it } from "vitest";

import { DEFAULT_VIEW, decodeView, encodeView, sortAlbums, sortSongs } from "./browse-view";
import { albumOf, trackOf } from "./test-fixtures";

describe("decodeView", () => {
  it("round-trips a stored view", () => {
    const view = { albums: { sort: "artist", layout: "list" }, songs: { sort: "artist" } } as const;

    expect(decodeView(encodeView(view))).toEqual(view);
  });

  it("falls back to Paper's defaults when nothing usable is stored", () => {
    expect(decodeView(null)).toEqual(DEFAULT_VIEW);
    expect(decodeView("{}")).toEqual(DEFAULT_VIEW);
    expect(
      decodeView('{"albums":{"sort":"plays","layout":"grid"},"songs":{"sort":"title"}}'),
    ).toEqual(DEFAULT_VIEW);
  });
});

describe("sortAlbums", () => {
  const albums = [albumOf("Mezzanine"), albumOf("dummy", "Portishead"), albumOf("Ágape", "Air")];

  it("keeps the server's newest-first order for Recently added", () => {
    expect(sortAlbums(albums, "added")).toBe(albums);
  });

  it("orders by title ignoring case and accents", () => {
    expect(sortAlbums(albums, "title").map((album) => album.title)).toEqual([
      "Ágape",
      "dummy",
      "Mezzanine",
    ]);
  });

  it("orders by artist, then title", () => {
    const more = [...albums, albumOf("Blue Lines")];

    expect(sortAlbums(more, "artist").map((album) => album.title)).toEqual([
      "Ágape",
      "Blue Lines",
      "Mezzanine",
      "dummy",
    ]);
  });
});

describe("sortSongs", () => {
  it("orders by artist, then title, and keeps the server's title order otherwise", () => {
    const tracks = [trackOf("Teardrop"), trackOf("Roads", "Portishead"), trackOf("Angel")];

    expect(sortSongs(tracks, "title")).toBe(tracks);
    expect(sortSongs(tracks, "artist").map((track) => track.title)).toEqual([
      "Angel",
      "Teardrop",
      "Roads",
    ]);
  });
});
