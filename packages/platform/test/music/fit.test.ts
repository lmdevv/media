import { getDocumentSize } from "convex/values";
import { describe, expect, it } from "vitest";

import type { Id } from "../../convex/_generated/dataModel";
import { NO_COST, cost, meterFrom, whileBudget } from "../../convex/music/budget";
import {
  MUSIC_BOUNDS,
  TABLE_BYTES,
  artHashWithin,
  checkLyrics,
  fitAlbum,
  fitArtist,
  fitLyrics,
  fitTrack,
  keyOf,
  lyricsFieldsOf,
  sameLyrics,
} from "../../convex/music/fit";
import type { LocalLyricSet } from "../../convex/music/validators";

/** `count` of a 3-byte character, the most bytes text of that length can take. */
const wide = (count: number): string => "語".repeat(count);

// SAFETY: a type predicate over a fixed string. Convex ids are opaque strings of 32 characters,
// and these documents are only measured, never written.
const isId = <Table extends "libraries" | "albums" | "artists">(
  _table: Table,
  value: string,
): value is Id<Table> => value.length === 32;

const idOf = <Table extends "libraries" | "albums" | "artists">(table: Table): Id<Table> => {
  const value = "k".repeat(32);

  if (!isId(table, value)) throw new Error("an id is 32 characters");

  return value;
};

const plain = (text: string): LocalLyricSet => ({
  kind: "main",
  lang: "en",
  origin: { _tag: "Embedded", tag: "id3:USLT" },
  body: { _tag: "Plain", text },
});

describe("music document bounds", () => {
  it("keep a track with every field at its longest within its bound", () => {
    const track = fitTrack({
      libraryId: idOf("libraries"),
      albumId: idOf("albums"),
      artistId: idOf("artists"),
      path: `/${"p".repeat(4095)}`,
      size: Number.MAX_SAFE_INTEGER,
      mtimeMs: Number.MAX_SAFE_INTEGER,
      title: wide(10_000),
      titleKey: wide(10_000),
      artistName: wide(10_000),
      albumTitle: wide(10_000),
      trackNumber: 1,
      discNumber: 1,
      durationMs: Number.MAX_SAFE_INTEGER,
      codec: wide(10_000),
      lossless: true,
      bitrate: 1,
      sampleRate: 1,
      bitDepth: 1,
      artHash: "a".repeat(MUSIC_BOUNDS.artHash),
      folderArt: wide(10_000),
      lyricsFiles: wide(10_000),
      lyricsReader: 1,
      lyricsBytes: 1,
      lyricsHash: "h".repeat(64),
      lyricsSynced: true,
      explicit: true,
      missing: false,
      searchText: wide(10_000),
      tie: crypto.randomUUID(),
    });

    expect(getDocumentSize(track)).toBeLessThanOrEqual(TABLE_BYTES.tracks);
    expect(artHashWithin("a".repeat(MUSIC_BOUNDS.artHash + 1))).toBeNull();
    expect(artHashWithin("a".repeat(MUSIC_BOUNDS.artHash))).toHaveLength(MUSIC_BOUNDS.artHash);
  });

  it("keep an album and an artist with every field at its longest within their bounds", () => {
    const album = fitAlbum({
      libraryId: idOf("libraries"),
      artistId: idOf("artists"),
      artistName: wide(10_000),
      title: wide(10_000),
      key: keyOf(wide(10_000)),
      year: 1,
      genre: wide(10_000),
      artHash: "a".repeat(MUSIC_BOUNDS.artHash),
      trackCount: Number.MAX_SAFE_INTEGER,
      durationMs: Number.MAX_SAFE_INTEGER,
      format: wide(10_000),
      addedAt: Number.MAX_SAFE_INTEGER,
      searchText: wide(10_000),
      tie: crypto.randomUUID(),
    });

    const artist = fitArtist({
      libraryId: idOf("libraries"),
      name: wide(10_000),
      key: keyOf(wide(10_000)),
      albumCount: Number.MAX_SAFE_INTEGER,
      artHash: "a".repeat(MUSIC_BOUNDS.artHash),
      searchText: wide(10_000),
      tie: crypto.randomUUID(),
    });

    expect(getDocumentSize(album)).toBeLessThanOrEqual(TABLE_BYTES.albums);
    expect(getDocumentSize(artist)).toBeLessThanOrEqual(TABLE_BYTES.artists);
  });

  it("keep two names that differ past the key's maximum as two keys", () => {
    const long = "x".repeat(MUSIC_BOUNDS.key + 10);

    expect(keyOf(`${long}a`)).not.toBe(keyOf(`${long}b`));
    expect(keyOf(`  ${long}A `)).toBe(keyOf(`${long}a`));
    expect(keyOf(`${long}a`).length).toBeLessThanOrEqual(MUSIC_BOUNDS.key);
  });

  it("keep a song's leading lyric sets within the lyrics row's bound", () => {
    const sets = Array.from({ length: 8 }, (_, n) => plain(`${n}`.repeat(100_000)));
    const fitted = fitLyrics(sets);

    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(sets.length);
    expect(fitted).toEqual(sets.slice(0, fitted.length));
    expect(getDocumentSize({ trackId: "k".repeat(32), sets: [...fitted] })).toBeLessThanOrEqual(
      TABLE_BYTES.localLyrics,
    );
    expect(fitLyrics([plain(wide(400_000))])).toEqual([]);
  });

  it("check lyric sets as old music's schema did", () => {
    expect(() => checkLyrics([plain("Words")])).not.toThrow();
    expect(() => checkLyrics([{ ...plain("Words"), lang: "pt-BR" }])).not.toThrow();
    expect(() => checkLyrics([{ ...plain("Words"), lang: "EN" }])).toThrow(/BCP 47/u);
    expect(() => checkLyrics([plain("")])).toThrow(/empty/u);
    expect(() =>
      checkLyrics([
        {
          ...plain("x"),
          body: {
            _tag: "Synced",
            lines: [{ text: "a", startMs: -1, endMs: null, words: null, voice: null }],
          },
        },
      ]),
    ).toThrow(/bad time/u);
    expect(() =>
      checkLyrics([
        {
          ...plain("x"),
          body: {
            _tag: "Synced",
            lines: [{ text: "a", startMs: 0, endMs: null, words: [], voice: null }],
          },
        },
      ]),
    ).toThrow(/no words/u);
  });
});

describe("music call budget", () => {
  const limit = { ...cost(1000, 1000, 100, 100), lyricBytes: 100 };

  it("start another write only while what the meter charged leaves room for the most one costs", async () => {
    const meter = meterFrom(NO_COST);

    const ran = await whileBudget(meter, limit, cost(1, 1, 30), [60, 5, 20, 1], async (bytes) => {
      meter.charge(cost(1, 1, bytes));

      return bytes;
    });

    expect(ran).toEqual([60, 5, 20]);
    expect(meter.spent().readBytes).toBe(85);
  });

  it("always run the first write, past a limit the call's own work already spent", async () => {
    const meter = meterFrom(cost(0, 0, 0, 500));
    const ran = await whileBudget(meter, limit, NO_COST, [1, 2], async (bytes) => bytes);

    expect(ran).toEqual([1]);
  });
});

/** How long `work` takes, in milliseconds. */
const timed = async (work: () => Promise<void>): Promise<number> => {
  const start = performance.now();

  await work();

  return performance.now() - start;
};

/** 8,192 sets, Convex's most in an array, of `length` characters each. */
const manySets = (length: number): ReadonlyArray<LocalLyricSet> =>
  Array.from({ length: 8192 }, (_, n) => plain(`${n} `.padEnd(length, "la ")));

describe("music lyrics fitting", () => {
  it.each([100, 1800])(
    "fit 8,192 sets of %i characters, up to as many as a call's 16 MiB holds, in one pass well inside a call's second",
    async (length) => {
      const input = manySets(length);

      const elapsed = await timed(async () => {
        checkLyrics(input);
        await lyricsFieldsOf(fitLyrics(input));
      });

      const fitted = fitLyrics(input);

      const [within, past] = await Promise.all([
        lyricsFieldsOf(fitted),
        lyricsFieldsOf(input.slice(0, fitted.length + 1)),
      ]);

      expect(elapsed).toBeLessThan(500);
      expect(fitted).toEqual(input.slice(0, fitted.length));
      expect(within.lyricsBytes).toBeLessThanOrEqual(TABLE_BYTES.localLyrics);
      expect(past.lyricsBytes).toBeGreaterThan(TABLE_BYTES.localLyrics);
    },
  );
});

const synced = (words: LyricWords): LocalLyricSet => ({
  kind: "main",
  lang: null,
  origin: { _tag: "Sidecar", fileName: "song.lrc", format: "elrc" },
  body: {
    _tag: "Synced",
    lines: [{ text: "La la", startMs: 0, endMs: 1000, words, voice: null }],
  },
});

type LyricWords = Extract<
  LocalLyricSet["body"],
  { readonly _tag: "Synced" }
>["lines"][number]["words"];

/** `set` with its fields, and its body's and origin's, in the reverse order, as Convex may hand them back. */
const reordered = (set: LocalLyricSet): LocalLyricSet => ({
  body: "text" in set.body ? { text: set.body.text, _tag: "Plain" } : set.body,
  origin: "tag" in set.origin ? { tag: set.origin.tag, _tag: "Embedded" } : set.origin,
  lang: set.lang,
  kind: set.kind,
});

describe("music lyrics comparison", () => {
  const words: LyricWords = [
    { text: "La", startMs: 0, endMs: 500 },
    { text: "la", startMs: 500, endMs: null },
  ];

  it("find the same sets equal in any field order, and any difference in a field, a word, or the count", () => {
    const sets = [plain("Words"), synced(words)];

    expect(sameLyrics(sets, sets.map(reordered))).toBe(true);
    expect(sameLyrics(sets, [plain("Words"), synced(words.map((word) => ({ ...word })))])).toBe(
      true,
    );
    expect(sameLyrics(sets, [plain("Words")])).toBe(false);
    expect(sameLyrics(sets, [{ ...plain("Words"), lang: null }, synced(words)])).toBe(false);
    expect(sameLyrics(sets, [{ ...plain("Words"), kind: "translation" }, synced(words)])).toBe(
      false,
    );
    expect(
      sameLyrics(sets, [
        { ...plain("Words"), origin: { _tag: "Embedded", tag: "other" } },
        synced(words),
      ]),
    ).toBe(false);
    expect(sameLyrics(sets, [plain("Word"), synced(words)])).toBe(false);
    expect(sameLyrics(sets, [plain("Words"), synced(null)])).toBe(false);
    expect(
      sameLyrics(sets, [
        plain("Words"),
        synced([...words.slice(0, 1), { text: "la", startMs: 500, endMs: 900 }]),
      ]),
    ).toBe(false);
    expect(sameLyrics(sets, [synced(words), plain("Words")])).toBe(false);
  });

  it("compare 8,192 one-character sets, the same or changed in the last, in a few milliseconds", async () => {
    const tiny = Array.from({ length: 8192 }, () => ({ ...plain("x"), lang: null }));
    const copy = tiny.map(reordered);
    const changed = [...copy.slice(0, -1), { ...plain("y"), lang: null }];

    const same = await timed(async () => {
      expect(sameLyrics(tiny, copy)).toBe(true);
    });

    const different = await timed(async () => {
      expect(sameLyrics(tiny, changed)).toBe(false);
    });

    expect(same + different).toBeLessThan(50);
  });
});
