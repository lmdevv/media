import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type LyricSet,
  LrclibRecordId,
  LyricOrigin,
  LyricsLookup,
  canLookUp,
  lookupKeyOf,
  parseLang,
  resolveLyrics,
  TrackLyrics,
} from "./lyrics";
import { UNKNOWN_ARTIST } from "./models";

const line = (text: string, startMs: number, words = false) => ({
  text,
  startMs,
  endMs: null,
  words: words ? ([{ text, startMs, endMs: null }] as const) : null,
  voice: null,
});

const synced = (
  origin: LyricSet["origin"],
  options: {
    readonly words?: boolean;
    readonly kind?: LyricSet["kind"];
    readonly lang?: string;
  } = {},
): LyricSet => ({
  kind: options.kind ?? "main",
  lang: options.lang === undefined ? null : parseLang(options.lang),
  origin,
  body: { _tag: "Synced", lines: [line("Hello", 1000, options.words)] },
});

const plain = (origin: LyricSet["origin"], kind: LyricSet["kind"] = "main"): LyricSet => ({
  kind,
  lang: null,
  origin,
  body: { _tag: "Plain", text: "Hello" },
});

const sidecar = { _tag: "Sidecar", fileName: "Song.lrc", format: "lrc" } as const;

const embedded = { _tag: "Embedded", tag: "id3:USLT" } as const;

const lrclib = { _tag: "Lrclib", recordId: LrclibRecordId.make(7) } as const;

const on = { remoteLookups: "on" } as const;

const off = { remoteLookups: "off" } as const;

const found = (...sets: ReadonlyArray<LyricSet>) => LyricsLookup.Found({ sets });

const originName = LyricOrigin.match({
  Sidecar: () => "Sidecar",
  Embedded: () => "Embedded",
  Lrclib: () => "Lrclib",
});

const summary = TrackLyrics.match({
  None: () => "None",
  Instrumental: () => "Instrumental",
  Pending: ({ fallback }) => `Pending ${fallback === null ? "none" : originName(fallback.origin)}`,
  Synced: ({ source, main }) => `Synced ${source} ${originName(main.origin)}`,
  Plain: ({ source, main }) => `Plain ${source} ${originName(main.origin)}`,
});

describe("resolveLyrics", () => {
  it.each([
    [
      "local synced beats LRCLIB synced",
      [synced(sidecar)],
      found(synced(lrclib)),
      on,
      "Synced file Sidecar",
    ],
    [
      "local synced beats a pending lookup",
      [synced(sidecar)],
      LyricsLookup.Pending(),
      on,
      "Synced file Sidecar",
    ],
    [
      "local synced beats instrumental",
      [synced(embedded)],
      LyricsLookup.Instrumental(),
      on,
      "Synced file Embedded",
    ],
    [
      "LRCLIB synced beats local plain",
      [plain(sidecar)],
      found(synced(lrclib)),
      on,
      "Synced lrclib Lrclib",
    ],
    [
      "local plain beats LRCLIB plain",
      [plain(sidecar)],
      found(plain(lrclib)),
      on,
      "Plain file Sidecar",
    ],
    [
      "local plain beats instrumental",
      [plain(embedded)],
      LyricsLookup.Instrumental(),
      on,
      "Plain file Embedded",
    ],
    [
      "local plain shows while LRCLIB is asked",
      [plain(sidecar)],
      LyricsLookup.Pending(),
      on,
      "Pending Sidecar",
    ],
    [
      "local plain with lookups off",
      [plain(sidecar)],
      LyricsLookup.Pending(),
      off,
      "Plain file Sidecar",
    ],
    ["local plain after a miss", [plain(sidecar)], LyricsLookup.None(), on, "Plain file Sidecar"],
    ["LRCLIB plain alone", [], found(plain(lrclib)), on, "Plain lrclib Lrclib"],
    ["LRCLIB synced alone", [], found(synced(lrclib)), on, "Synced lrclib Lrclib"],
    [
      "LRCLIB answers stay with lookups off",
      [],
      found(synced(lrclib)),
      off,
      "Synced lrclib Lrclib",
    ],
    ["instrumental with nothing local", [], LyricsLookup.Instrumental(), on, "Instrumental"],
    ["instrumental stays with lookups off", [], LyricsLookup.Instrumental(), off, "Instrumental"],
    ["a pending lookup with nothing local", [], LyricsLookup.Pending(), on, "Pending none"],
    ["a pending lookup that will not run", [], LyricsLookup.Pending(), off, "None"],
    ["nothing anywhere", [], LyricsLookup.None(), on, "None"],
    ["only a translation", [plain(sidecar, "translation")], LyricsLookup.None(), on, "None"],
  ] as const)("%s", (_, local, lookup, options, expected) => {
    expect(summary(resolveLyrics(local, lookup, options))).toBe(expected);
  });

  it("prefers a file beside the song over a tag, then word timing", () => {
    const tagged = synced(embedded, { words: true });
    const file = synced(sidecar);

    const fileWithWords = synced(
      { ...sidecar, fileName: "Song.ttml", format: "ttml" },
      { words: true },
    );

    expect(resolveLyrics([tagged, file], LyricsLookup.None(), on)).toMatchObject({
      main: { origin: { fileName: "Song.lrc" } },
    });
    expect(resolveLyrics([tagged, file, fileWithWords], LyricsLookup.None(), on)).toMatchObject({
      main: { origin: { fileName: "Song.ttml" } },
    });
    expect(resolveLyrics([plain(embedded), plain(sidecar)], LyricsLookup.None(), on)).toMatchObject(
      {
        main: { origin: { _tag: "Sidecar" } },
      },
    );
  });

  it("keeps the sets that lose in extras, and picks the first of equals", () => {
    const english = synced({ ...sidecar, fileName: "Song.en.lrc" }, { lang: "en" });
    const japanese = synced({ ...sidecar, fileName: "Song.ja.lrc" }, { lang: "ja" });
    const tagged = synced(embedded);
    const taggedPlain = plain(embedded);

    expect(
      resolveLyrics([english, japanese, tagged, taggedPlain], LyricsLookup.None(), on),
    ).toEqual({
      _tag: "Synced",
      source: "file",
      main: english,
      extras: [japanese, tagged, taggedPlain],
    });
    expect(resolveLyrics([japanese, english], LyricsLookup.None(), on)).toMatchObject({
      main: japanese,
      extras: [english],
    });
    expect(resolveLyrics([], found(plain(lrclib), plain(lrclib)), on)).toMatchObject({
      extras: [plain(lrclib)],
    });
  });

  it("carries the other sets from the same source", () => {
    const translation = plain({ ...sidecar, fileName: "Song.de.lrc" }, "translation");
    const remoteTranslation = plain(lrclib, "translation");

    expect(resolveLyrics([synced(sidecar), translation], found(synced(lrclib)), on)).toMatchObject({
      extras: [translation],
    });
    expect(
      resolveLyrics([plain(sidecar), translation], found(synced(lrclib), remoteTranslation), on),
    ).toMatchObject({ source: "lrclib", extras: [remoteTranslation] });
  });
});

const key = (artist: string, title: string, album = "Album", durationMs = 200_000) =>
  lookupKeyOf({ artist, title, album, durationMs });

const titleKey = (text: string) => key("Artist", text).split("|")[2];

describe("canLookUp", () => {
  const song = { artist: "Artist", title: "Title", album: "", durationMs: 200_000 };

  it("needs a title, an artist, and a length of a whole second", () => {
    expect(canLookUp(song)).toBe(true);
    expect(canLookUp({ ...song, title: " (feat. Guest) " })).toBe(false);
    expect(canLookUp({ ...song, artist: "" })).toBe(false);
    expect(canLookUp({ ...song, artist: UNKNOWN_ARTIST })).toBe(false);
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

describe("parseLang", () => {
  it("reads the language codes files and tags write", () => {
    expect(parseLang("eng")).toBe("en");
    expect(parseLang("deu")).toBe("de");
    expect(parseLang("en_us")).toBe("en-US");
    expect(parseLang("ja-latn")).toBe("ja-Latn");
    expect(parseLang(" zh-Hant ")).toBe("zh-Hant");
  });

  it("returns null for tags that name no language", () => {
    expect(parseLang("XXX")).toBeNull();
    expect(parseLang("und")).toBeNull();
    expect(parseLang("")).toBeNull();
    expect(parseLang("english")).toBeNull();
    expect(parseLang("Brightside")).toBeNull();
  });
});
