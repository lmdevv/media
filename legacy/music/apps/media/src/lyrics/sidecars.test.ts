import { type LyricSet, parseLang } from "@music/commands/lyrics";
import { describe, expect, it } from "vitest";

import type { WalkedFile } from "../platform/node-files.ts";
import type { ParsedLyricSet } from "./lyric-body.ts";
import {
  isLyricsSidecar,
  localLyricSets,
  lyricsFilesKey,
  lyricsSidecarMatcher,
  type LyricsSidecar,
} from "./sidecars.ts";

const walked = (relativePath: string, size = 100, mtimeMs = 1_700_000_000_000.5): WalkedFile => ({
  relativePath,
  size,
  mtimeMs,
});

const library = [
  "Album/01 Song.flac",
  "Album/01 Song.lrc",
  "Album/01 Song.de.lrc",
  "Album/01 Song.pt-BR.srt",
  "Album/01 Song.lyricsfile.yaml",
  "Album/01 Song.ja.lyricsfile.yaml",
  "Album/01 Song.notes.txt",
  "Album/01 Song.alt.lrc",
  "Album/01 Song.old.lrc",
  "Album/01 Song.bak.lrc",
  "Album/01 Song.new.lrc",
  "Album/01 Song.fix.lrc",
  "Album/01 Song.xx.lrc",
  "Album/01 Song.en.flac",
  "Album/01 Song.en.lrc",
  "Album/02 Other.mp3",
  "Album/cover.jpg",
  "Elsewhere/01 Song.lrc",
].map((path) => walked(path));

const match = lyricsSidecarMatcher(library);

const matched = (audioPath: string) =>
  match(audioPath).map(({ file, format, lang }) => [file.relativePath, format, lang]);

describe("lyricsSidecarMatcher", () => {
  it("finds a song's lyric files by its name, its own name first", () => {
    expect(matched("Album/01 Song.flac")).toEqual([
      ["Album/01 Song.lrc", "lrc", null],
      ["Album/01 Song.lyricsfile.yaml", "lyricsfile", null],
      ["Album/01 Song.de.lrc", "lrc", "de"],
      ["Album/01 Song.ja.lyricsfile.yaml", "lyricsfile", "ja"],
      ["Album/01 Song.pt-BR.srt", "srt", "pt-BR"],
    ]);
  });

  it("reads only an ISO 639-1 language from a name, not a word such as alt or bak", () => {
    expect(matched("Album/01 Song.flac").map(([path]) => path)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.(?:alt|old|bak|new|fix|xx)\.lrc$/u)]),
    );
  });

  it("reads a language, script, and region from a name, and no other subtag", () => {
    const named = [
      "en-GB",
      "zh-Hant",
      "pt_br",
      "zh-Hant-TW",
      "es-419",
      "en-live",
      "en-notes",
      "no-lyrics",
      "en-XX",
    ].map((suffix) => walked(`Album/Song.${suffix}.lrc`));

    expect(
      lyricsSidecarMatcher([walked("Album/Song.flac"), ...named])("Album/Song.flac").map(
        ({ lang }) => lang,
      ),
    ).toEqual(["en-GB", "es-419", "pt-BR", "zh-Hant-TW", "zh-Hant"]);
  });

  it("matches a flat folder of 10,000 songs without comparing each song to every file", () => {
    const names = Array.from({ length: 10_000 }, (_, index) => `Flat/${index} Track`);

    const matchFlat = lyricsSidecarMatcher(
      names.flatMap((name) => [walked(`${name}.mp3`), walked(`${name}.lrc`)]),
    );

    const start = performance.now();
    const found = names.map((name) => matchFlat(`${name}.mp3`));

    expect(found.every((sidecars) => sidecars.length === 1)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("gives a name that is another song's exact name to that song, not a language", () => {
    expect(matched("Album/01 Song.en.flac")).toEqual([["Album/01 Song.en.lrc", "lrc", null]]);
  });

  it("matches only within the song's folder, and nothing for a song without files", () => {
    expect(matched("Album/02 Other.mp3")).toEqual([]);
    expect(matched("Elsewhere/01 Song.mp3")).toEqual([["Elsewhere/01 Song.lrc", "lrc", null]]);
  });

  it("tells lyric files from other files by extension", () => {
    expect(
      ["a.lrc", "a.ELRC", "a.ttml", "a.vtt", "a.srt", "a.txt", "a.yaml", "a.yml"].every(
        isLyricsSidecar,
      ),
    ).toBe(true);
    expect(["a.flac", "cover.jpg", "a.cue", "lrc"].some(isLyricsSidecar)).toBe(false);
  });
});

describe("lyricsFilesKey", () => {
  it("changes when a lyric file changes, and is empty for none", () => {
    const sidecars = match("Album/01 Song.flac");
    const key = lyricsFilesKey(sidecars);

    const resized = sidecars.map((sidecar, index) =>
      index === 0 ? { ...sidecar, file: walked(sidecar.file.relativePath, 101) } : sidecar,
    );

    expect(key).toBe(
      [
        "01 Song.de.lrc:100:1700000000000",
        "01 Song.ja.lyricsfile.yaml:100:1700000000000",
        "01 Song.lrc:100:1700000000000",
        "01 Song.lyricsfile.yaml:100:1700000000000",
        "01 Song.pt-BR.srt:100:1700000000000",
      ].join("/"),
    );
    expect(lyricsFilesKey(sidecars.toReversed())).toBe(key);
    expect(lyricsFilesKey(resized)).not.toBe(key);
    expect(lyricsFilesKey([])).toBe("");
  });
});

const plainSet = (text: string, lang: string | null = null): ParsedLyricSet => ({
  kind: "main",
  lang: lang === null ? null : parseLang(lang),
  body: { _tag: "Plain", text },
});

const sidecar = (relativePath: string, lang: string | null): LyricsSidecar => ({
  file: walked(relativePath),
  format: "lrc",
  lang: lang === null ? null : parseLang(lang),
});

const taggedIn = (lang: string | null): LyricSet => ({
  kind: "main",
  lang: lang === null ? null : parseLang(lang),
  origin: { _tag: "Embedded", tag: "id3:USLT" },
  body: { _tag: "Plain", text: "From the tag" },
});

const tagged = taggedIn(null);

const kinds = (sets: ReadonlyArray<LyricSet>) =>
  sets.map((set) => [set.kind, set.lang, set.origin]);

describe("localLyricSets", () => {
  const german = { sidecar: sidecar("A/Song.de.lrc", "de"), sets: [plainSet("Hallo")] };

  it("makes a language-named file a translation of the song's own lyrics file", () => {
    const own = { sidecar: sidecar("A/Song.lrc", null), sets: [plainSet("Hello", "en")] };

    expect(kinds(localLyricSets([own, german], []))).toEqual([
      ["main", "en", { _tag: "Sidecar", fileName: "Song.lrc", format: "lrc" }],
      ["translation", "de", { _tag: "Sidecar", fileName: "Song.de.lrc", format: "lrc" }],
    ]);
  });

  it("makes a language-named file a translation of lyrics in the song's tags", () => {
    expect(kinds(localLyricSets([german], [taggedIn("en")]))).toEqual([
      ["translation", "de", { _tag: "Sidecar", fileName: "Song.de.lrc", format: "lrc" }],
      ["main", "en", { _tag: "Embedded", tag: "id3:USLT" }],
    ]);
  });

  it("keeps a language-named file as main lyrics beside main lyrics in its language or none", () => {
    const english = { sidecar: sidecar("A/Song.en.lrc", "en"), sets: [plainSet("Hello")] };
    const sameLanguage = taggedIn("en");
    const regional = { sidecar: sidecar("A/Song.en-GB.lrc", "en-GB"), sets: [plainSet("Hello")] };

    expect(kinds(localLyricSets([english], [sameLanguage]))).toEqual([
      ["main", "en", { _tag: "Sidecar", fileName: "Song.en.lrc", format: "lrc" }],
      ["main", "en", { _tag: "Embedded", tag: "id3:USLT" }],
    ]);
    expect(kinds(localLyricSets([german], [tagged]))).toEqual([
      ["main", "de", { _tag: "Sidecar", fileName: "Song.de.lrc", format: "lrc" }],
      ["main", null, { _tag: "Embedded", tag: "id3:USLT" }],
    ]);
    expect(kinds(localLyricSets([regional], [sameLanguage]))[0]?.[0]).toBe("main");
  });

  it("makes a language-named file the song's lyrics when there are no others", () => {
    expect(kinds(localLyricSets([german], []))).toEqual([
      ["main", "de", { _tag: "Sidecar", fileName: "Song.de.lrc", format: "lrc" }],
    ]);
  });

  it("keeps the kinds a file gives its own sets", () => {
    const ttml = {
      sidecar: sidecar("A/Song.ttml", null),
      sets: [
        plainSet("こんにちは", "ja"),
        { ...plainSet("Hello", "en"), kind: "translation" as const },
      ],
    };

    expect(localLyricSets([ttml], []).map((set) => [set.kind, set.lang])).toEqual([
      ["main", "ja"],
      ["translation", "en"],
    ]);
  });
});
