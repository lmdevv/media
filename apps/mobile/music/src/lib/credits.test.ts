import { creditLine, creditsOf } from "@media/contracts/artist-credits";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { creditArtists, creditText, creditsOthers } from "./credits";
import { asArtistId } from "./models";
import type { Track } from "./models";
import { trackOf } from "./test-fixtures";

const NAMES = ["Mora", "JHAYCO", "Sech", "Bad Bunny", "Feid", "Young Miko"] as const;

const idOf = (name: string) => asArtistId(`ar-${name}`);

/** `title` by `artist` crediting `names`, in order; the first is its `artistId`. */
const songBy = (artist: string, names: ReadonlyArray<string>, title = "Song"): Track => {
  const [first] = names;

  return {
    ...trackOf(title, artist),
    artistId: idOf(first ?? artist),
    credits: names.map((name) => ({ artistId: idOf(name), name })),
  };
};

/** A song whose tags name some of the credited artists, joined as tags join them. */
const credited = fc
  .record({
    shown: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }),
    extra: fc.uniqueArray(fc.constantFrom(...NAMES), { maxLength: 3 }),
    join: fc.constantFrom(" & ", ", ", " feat. ", " y "),
  })
  .map(({ shown, extra, join }) =>
    songBy(shown.join(join), [...shown, ...extra.filter((name) => !shown.includes(name))]),
  );

describe("creditText", () => {
  it("is the artist as tagged for a song without credits", () => {
    expect(creditText(trackOf("Angel", "Massive Attack"))).toBe("Massive Attack");
    expect(creditText({ artist: "Mora & JHAYCO", credits: [] })).toBe("Mora & JHAYCO");
  });

  it("keeps the tags' joins when they name every credit", () => {
    expect(creditText(songBy("Mora & JHAYCO", ["Mora", "JHAYCO"]))).toBe("Mora & JHAYCO");
    expect(creditText(songBy("Mora y Sech", ["Mora", "Sech"]))).toBe("Mora y Sech");
  });

  it("adds a featured artist the tags' artist doesn't name, as the line does", () => {
    const song = songBy("Mora", ["Mora", "Young Miko"], "TOA (feat. Young Miko)");

    const line = creditLine(song)
      .map((piece) => (piece.kind === "text" ? piece.text : piece.name))
      .join("");

    expect(creditText(song)).toBe(line);
    expect(creditText(song)).toMatch(/^Mora.+Young Miko$/u);
  });

  it("starts with the artist as tagged and names every credit", () => {
    fc.assert(
      fc.property(credited, (song) => {
        const text = creditText(song);

        expect(text.startsWith(song.artist)).toBe(true);

        for (const credit of creditsOf(song)) {
          expect(text.toLowerCase()).toContain(credit.name.toLowerCase());
        }
      }),
    );
  });
});

describe("creditArtists", () => {
  it("offers the one artist of a song without credits", () => {
    const song = trackOf("Angel", "Massive Attack");

    expect(creditArtists(song)).toEqual([{ artistId: song.artistId, name: "Massive Attack" }]);
  });

  it("offers each credited artist in the order the line shows them", () => {
    const song = songBy("Mora & JHAYCO", ["Mora", "JHAYCO", "Sech"]);

    expect(creditArtists(song).map((artist) => artist.name)).toEqual(["Mora", "JHAYCO", "Sech"]);
  });

  it("names an artist as the line spells them", () => {
    expect(creditArtists(songBy("MORA & Jhayco", ["Mora", "JHAYCO"]))).toEqual([
      { artistId: idOf("Mora"), name: "MORA" },
      { artistId: idOf("JHAYCO"), name: "Jhayco" },
    ]);
  });

  it("offers every credited artist once, and nothing else", () => {
    fc.assert(
      fc.property(credited, (song) => {
        const ids = creditArtists(song).map((artist) => artist.artistId);

        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ids)).toEqual(new Set(creditsOf(song).map((credit) => credit.artistId)));
      }),
    );
  });
});

describe("creditsOthers", () => {
  it("tells a shared or featured song from one an artist sings alone", () => {
    expect(creditsOthers(songBy("Mora", ["Mora"]), idOf("Mora"))).toBe(false);
    expect(creditsOthers(songBy("Mora & JHAYCO", ["Mora", "JHAYCO"]), idOf("Mora"))).toBe(true);
    expect(creditsOthers(songBy("Mora", ["Mora", "Sech"]), idOf("Sech"))).toBe(true);
  });

  it("counts a song without credits as its one artist's", () => {
    const song = trackOf("Angel", "Massive Attack");

    expect(creditsOthers(song, song.artistId)).toBe(false);
    expect(creditsOthers(song, idOf("Mora"))).toBe(true);
  });
});
