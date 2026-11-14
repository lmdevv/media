import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canLookUp, lookupKeyOf } from "./lyrics-lookup";

const key = (artist: string, title: string, album = "Album", durationMs = 200_000) =>
  lookupKeyOf({ artist, title, album, durationMs });

const titleKey = (text: string) => key("Artist", text).split("|")[2];

describe("canLookUp", () => {
  const song = { artist: "Artist", title: "Title", album: "", durationMs: 200_000 };

  it("needs a title, an artist, and a length of a whole second", () => {
    expect(canLookUp(song)).toBe(true);
    expect(canLookUp({ ...song, title: " (feat. Guest) " })).toBe(false);
    expect(canLookUp({ ...song, artist: "" })).toBe(false);
    expect(canLookUp({ ...song, artist: "Unknown Artist" })).toBe(false);
    expect(canLookUp({ ...song, artist: "unknown artist" })).toBe(false);
    expect(canLookUp({ ...song, durationMs: 499 })).toBe(false);
    expect(canLookUp({ ...song, durationMs: 500 })).toBe(true);
  });
});

describe("lookupKeyOf", () => {
  it("versions the key and rounds the duration to whole seconds", () => {
    expect(key("Artist", "Title", "Album", 200_499)).toBe("v1|artist|title|album|200");
    expect(key("Artist", "Title", "Album", 200_500)).toBe("v1|artist|title|album|201");
  });

  it("drops featured artists and remaster labels", () => {
    const plainKey = key("Artist", "Song", "Album");

    expect(key("Artist feat. Guest", "Song", "Album")).toBe(plainKey);
    expect(key("Artist ft. Guest", "Song (feat. Guest)", "Album")).toBe(plainKey);
    expect(key("Artist featuring Guest", "Song [ft. Guest]", "Album")).toBe(plainKey);
    expect(key("Artist", "Song (Remastered 2011)", "Album (2009 Remaster)")).toBe(plainKey);
    expect(key("Artist", "Song - Remastered 2011", "Album")).toBe(plainKey);
    expect(key("Artist", "Song - 2011 Remaster", "Album [Remastered]")).toBe(plainKey);
  });

  it("keeps live, acoustic, and edit labels", () => {
    expect(key("Artist", "Song (Live)")).toBe("v1|artist|song (live)|album|200");
    expect(key("Artist", "Song - Acoustic")).toBe("v1|artist|song - acoustic|album|200");
    expect(key("Artist", "Song (Radio Edit)")).toBe("v1|artist|song (radio edit)|album|200");
  });

  it("removes only the remaster label from a label that says more", () => {
    expect(titleKey("Song (Live - 2011 Remaster)")).toBe("song (live)");
    expect(titleKey("Song (Live / Remastered 2011)")).toBe("song (live)");
    expect(titleKey("Song (Acoustic, Remastered 2011)")).toBe("song (acoustic)");
    expect(titleKey("Song (Remastered 2011 / Mono)")).toBe("song (mono)");
    expect(titleKey("Song - Remastered 2011 - Radio Edit")).toBe("song - radio edit");
    expect(titleKey("Song - Live / Remastered 2011")).toBe("song - live");
    expect(titleKey("Song - 2011 Remaster - Live")).toBe("song - live");
    expect(titleKey("Song (2015 Digital Remaster)")).toBe("song");
  });

  it("keeps a trailing feat or ft without a dot, which is a word", () => {
    expect(key("Little Feat & Friends", "A Feat of Clay")).toBe(
      "v1|little feat & friends|a feat of clay|album|200",
    );
    expect(key("Artist", "Song ft Guest")).toBe("v1|artist|song ft guest|album|200");
  });

  it("folds case, accents, quotes, and width, and keeps kana and Hangul", () => {
    expect(key("Beyoncé", "Déjà Vu")).toBe(key("BEYONCE", "deja vu"));
    expect(key("Artist", "Don’t Stop")).toBe(key("Artist", "Don't Stop"));
    expect(key("Artist", "“Quoted”")).toBe(key("Artist", '"Quoted"'));
    expect(key("ＡＢＣ", "Song")).toBe(key("abc", "Song"));
    expect(key("宇多田ヒカル", "ガンダム")).toBe("v1|宇多田ヒカル|ガンダム|album|200");
    expect(key("방탄소년단", "봄날")).toBe("v1|방탄소년단|봄날|album|200");
  });

  it("does not let a field's own separator shift the others", () => {
    expect(key("A|B", "C")).not.toBe(key("A", "B|C"));
  });

  it("ignores case and surrounding space", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z ]{0,20}$/u), (title) => {
        expect(key("Artist", ` ${title.toUpperCase()}  `)).toBe(key("artist", title));
      }),
    );
  });
});
