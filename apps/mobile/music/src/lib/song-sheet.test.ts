import { describe, expect, it } from "vitest";

import { asArtistId } from "./models";
import { parseSongSheet, songSheetParams } from "./song-sheet";
import { trackOf } from "./test-fixtures";

describe("song sheet params", () => {
  it("carry a song through the route and back", () => {
    const { id, title, artist, artistId, album, albumId } = trackOf("Safe from Harm");
    const song = { id, title, artist, artistId, album, albumId, liked: true };

    expect(parseSongSheet(songSheetParams(song))).toEqual(song);
  });

  it("carry every artist a song credits", () => {
    const { id, title, album, albumId } = trackOf("Media Luna");
    const mora = asArtistId("ar-Mora");
    const jhayco = asArtistId("ar-JHAYCO");

    const song = {
      id,
      title,
      artist: "Mora & JHAYCO",
      artistId: mora,
      credits: [
        { artistId: mora, name: "Mora" },
        { artistId: jhayco, name: "JHAYCO" },
      ],
      album,
      albumId,
      liked: false,
    };

    expect(parseSongSheet(songSheetParams(song))).toEqual(song);
  });

  it("describe a song from params without credits, which credit its artist", () => {
    const params = songSheetParams({ ...trackOf("Angel"), liked: false });

    expect(params).not.toHaveProperty("credits");
    expect(parseSongSheet(params)).not.toHaveProperty("credits");
  });

  it("describe no song when a param is missing or unreadable", () => {
    const withoutTitle = Object.fromEntries(
      Object.entries(songSheetParams(trackOf("Angel"))).filter(([key]) => key !== "title"),
    );

    expect(parseSongSheet(withoutTitle)).toBeNull();
    expect(parseSongSheet({ id: "x" })).toBeNull();
    expect(parseSongSheet({ ...songSheetParams(trackOf("Angel")), credits: "[{" })).toBeNull();
  });
});
