import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  TOP_SONGS,
  artistSongLine,
  artistStats,
  artistSummary,
  distinctTracks,
  hasMoreSongs,
} from "./artists";
import { creditText } from "./credits";
import { asArtistId, asTrackId } from "./models";
import { albumOf, artistOf, trackOf } from "./test-fixtures";

const songs = (count: number) =>
  Array.from({ length: count }, (_, index) => trackOf(`Song ${String(index)}`));

describe("artistSummary", () => {
  it("counts an artist's albums", () => {
    expect(artistSummary(artistOf("Air", 3))).toBe("3 albums");
    expect(artistSummary({ albumCount: 1, trackCount: 12 })).toBe("1 album");
  });

  it("counts the songs of an artist with no albums, such as one who only features", () => {
    expect(artistSummary({ albumCount: 0, trackCount: 2 })).toBe("2 songs");
    expect(artistSummary(artistOf("Sech", 0))).toBe("0 albums");
  });
});

describe("artistStats", () => {
  it("counts albums and the songs crediting the artist", () => {
    expect(artistStats({ albumCount: 2, trackCount: 31 }, [albumOf("A"), albumOf("B")])).toBe(
      "2 albums · 31 songs",
    );
  });

  it("counts their albums' songs for an artist without a song count", () => {
    expect(artistStats(artistOf("Air", 2), [albumOf("A"), albumOf("B")])).toBe(
      "2 albums · 18 songs",
    );
  });

  it("leaves out albums for an artist who only features", () => {
    expect(artistStats({ albumCount: 0, trackCount: 1 }, [])).toBe("1 song");
  });
});

describe("hasMoreSongs", () => {
  it("is false once the top songs hold every song", () => {
    expect(hasMoreSongs({ albumCount: 1 }, songs(4))).toBe(false);
    expect(hasMoreSongs({ albumCount: 1, trackCount: TOP_SONGS }, songs(TOP_SONGS))).toBe(false);
  });

  it("is true while more songs credit the artist, or their count is unknown", () => {
    expect(hasMoreSongs({ albumCount: 1, trackCount: 40 }, songs(TOP_SONGS))).toBe(true);
    expect(hasMoreSongs({ albumCount: 1 }, songs(TOP_SONGS))).toBe(true);
  });

  it("is true when the top songs came back short of the artist's songs, as a filter hides some", () => {
    expect(hasMoreSongs({ albumCount: 1, trackCount: 40 }, songs(3))).toBe(true);
  });
});

describe("artistSongLine", () => {
  const mora = asArtistId("ar-Mora");

  it("is the album and its year for a song the artist sings alone", () => {
    const song = { ...trackOf("Volando", "Mora", "Paraíso"), artistId: mora };

    expect(artistSongLine(song, mora, 2022)).toBe("Paraíso · 2022");
    expect(artistSongLine(song, mora, null)).toBe("Paraíso");
  });

  it("names the song's artists first when it credits anyone else", () => {
    const song = {
      ...trackOf("Media Luna", "JHAYCO", "Vida Rockstar"),
      artistId: asArtistId("ar-JHAYCO"),
      credits: [
        { artistId: asArtistId("ar-JHAYCO"), name: "JHAYCO" },
        { artistId: mora, name: "Mora" },
      ],
    };

    expect(artistSongLine(song, mora, null)).toBe(`${creditText(song)} · Vida Rockstar`);
  });
});

const rowsOf = (keys: ReadonlyArray<string>) =>
  keys.map((key, index) => ({ id: asTrackId(key), index }));

describe("distinctTracks", () => {
  const ids = fc.array(fc.constantFrom<string>("a", "b", "c", "d", "e"), { maxLength: 30 });

  it("lists each song once, at its first row, in order", () => {
    fc.assert(
      fc.property(ids, (keys) => {
        const rows = rowsOf(keys);
        const distinct = distinctTracks(rows);

        expect(distinct.map((row) => row.id)).toEqual([...new Set(keys)]);

        for (const row of distinct) {
          expect(row.index).toBe(keys.indexOf(row.id));
        }

        expect(distinctTracks(distinct)).toEqual(distinct);
      }),
    );
  });
});
