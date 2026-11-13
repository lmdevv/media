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
  const limit = { work: cost(1000, 1000).work, readBytes: 100, writeBytes: 100 };

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
const timed = (work: () => void): number => {
  const start = performance.now();

  work();

  return performance.now() - start;
};

/** 8,192 sets, Convex's most in an array, of `length` characters each. */
const manySets = (length: number): ReadonlyArray<LocalLyricSet> =>
  Array.from({ length: 8192 }, (_, n) => plain(`${n} `.padEnd(length, "la ")));

describe("music lyrics fitting", () => {
  it("fit 8,192 sets of 100 characters, or as long as a call's 16 MiB holds, in one pass well inside a call's second", () => {
    for (const input of [manySets(100), manySets(1800)]) {
      const elapsed = timed(() => {
        checkLyrics(input);
        lyricsFieldsOf(fitLyrics(input));
      });

      const fitted = fitLyrics(input);

      expect(elapsed).toBeLessThan(500);
      expect(fitted).toEqual(input.slice(0, fitted.length));
      expect(lyricsFieldsOf(fitted).lyricsBytes).toBeLessThanOrEqual(TABLE_BYTES.localLyrics);
      expect(lyricsFieldsOf(input.slice(0, fitted.length + 1)).lyricsBytes).toBeGreaterThan(
        TABLE_BYTES.localLyrics,
      );
    }
  });
});
