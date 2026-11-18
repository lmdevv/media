import { describe, expect, it } from "vitest";

import { parseSongSheet, songSheetParams } from "./song-sheet";
import { trackOf } from "./test-fixtures";

describe("song sheet params", () => {
  it("carry a song through the route and back", () => {
    const { id, title, artist, artistId, album, albumId } = trackOf("Safe from Harm");
    const song = { id, title, artist, artistId, album, albumId, liked: true };

    expect(parseSongSheet(songSheetParams(song))).toEqual(song);
  });

  it("describe no song when a param is missing", () => {
    const withoutTitle = Object.fromEntries(
      Object.entries(songSheetParams(trackOf("Angel"))).filter(([key]) => key !== "title"),
    );

    expect(parseSongSheet(withoutTitle)).toBeNull();
    expect(parseSongSheet({ id: "x" })).toBeNull();
  });
});
