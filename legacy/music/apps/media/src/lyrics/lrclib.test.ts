import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { LrclibLyrics, parseLrclibRecord } from "./lrclib.ts";

interface RecordFields {
  readonly instrumental?: boolean;
  readonly hasWordSync?: boolean;
  readonly plainLyrics?: string;
  readonly syncedLyrics?: string;
  readonly lyricsfile?: string;
}

const record = (fields: RecordFields): string =>
  JSON.stringify({
    id: 3396226,
    name: "Song",
    trackName: "Song",
    artistName: "Artist",
    albumName: "Album",
    duration: 233,
    instrumental: false,
    hasWordSync: false,
    plainLyrics: null,
    syncedLyrics: null,
    lyricsfile: null,
    ...fields,
  });

const lyricsOf = (json: string) =>
  LrclibLyrics.$match(Result.getOrThrow(parseLrclibRecord(json)), {
    Found: ({ recordId, sets }) => ({ recordId, sets }),
    Instrumental: ({ recordId }) => ({ instrumental: recordId }),
    Empty: ({ recordId }) => ({ empty: recordId }),
  });

const failureOf = (json: string) =>
  Result.match(parseLrclibRecord(json), {
    onSuccess: () => undefined,
    onFailure: (error) => error.reason,
  });

describe("parseLrclibRecord", () => {
  it("prefers synced lyrics over plain ones", () => {
    const found = lyricsOf(
      record({ plainLyrics: "One\nTwo", syncedLyrics: "[00:17.12] One\n[00:20.41] Two\n" }),
    );

    expect(found).toEqual({
      recordId: 3396226,
      sets: [
        {
          kind: "main",
          lang: null,
          origin: { _tag: "Lrclib", recordId: 3396226 },
          body: {
            _tag: "Synced",
            lines: [
              { text: "One", startMs: 17_120, endMs: null, words: null, voice: null },
              { text: "Two", startMs: 20_410, endMs: null, words: null, voice: null },
            ],
          },
        },
      ],
    });
  });

  it("takes word timing from the record's Lyricsfile", () => {
    const lyricsfile = [
      "version: '1.0'",
      "metadata:",
      "  title: Song",
      "  artist: Artist",
      "  language: en",
      "lines:",
      "- text: One two",
      "  start_ms: 17120",
      "  words:",
      "  - {text: 'One ', start_ms: 17120, end_ms: 17500}",
      "  - {text: two, start_ms: 17500}",
      "- text: Three",
      "  start_ms: 20410",
    ].join("\n");

    const found = lyricsOf(
      record({ hasWordSync: true, syncedLyrics: "[00:17.12]One two\n[00:20.41]Three", lyricsfile }),
    );

    expect(found).toMatchObject({
      sets: [
        {
          lang: "en",
          body: { lines: [{ words: [{ text: "One ", endMs: 17_500 }, { text: "two" }] }, {}] },
        },
      ],
    });
  });

  it("falls back to synced lyrics when the Lyricsfile is broken, and to plain lyrics last", () => {
    expect(
      lyricsOf(record({ lyricsfile: "version: [", syncedLyrics: "[00:01.00]A\n[00:02.00]B" })),
    ).toMatchObject({ sets: [{ body: { _tag: "Synced" } }] });
    expect(
      lyricsOf(record({ syncedLyrics: "[00:00.00]A\n[00:00.00]B", plainLyrics: "A\n\nB" })),
    ).toMatchObject({ sets: [{ body: { _tag: "Plain", text: "A\nB" } }] });
    expect(lyricsOf(record({ plainLyrics: "Only plain" }))).toMatchObject({
      sets: [{ body: { _tag: "Plain", text: "Only plain" } }],
    });
  });

  it("answers instrumental for an instrumental record, whatever its text says", () => {
    expect(lyricsOf(record({ instrumental: true, plainLyrics: "la la" }))).toEqual({
      instrumental: 3396226,
    });
  });

  it("answers empty for a record without lyrics", () => {
    expect(lyricsOf(record({ plainLyrics: "   " }))).toEqual({ empty: 3396226 });
  });

  it("fails when the record's lyrics are there but none can be read", () => {
    const tooLong = Array.from(
      { length: 2001 },
      (_, index) => `[${Math.floor(index / 60)}:${index % 60}.00]x${index}`,
    ).join("\n");

    expect(failureOf(record({ lyricsfile: "version: [" }))).toBe("malformed");
    expect(failureOf(record({ syncedLyrics: tooLong }))).toBe("too-long");
    expect(failureOf(record({ plainLyrics: "x".repeat(256 * 1024 + 1) }))).toBe("too-large");
    expect(failureOf(record({ syncedLyrics: `[${"9".repeat(310)}:01]Line` }))).toBe("malformed");
  });

  it("fails for a body that is not an LRCLIB record", () => {
    for (const body of ["<html>busy</html>", "{}", JSON.stringify({ id: -1 })]) {
      expect(Result.isFailure(parseLrclibRecord(body))).toBe(true);
    }

    expect(failureOf(JSON.stringify({ id: 1 }))).toBe("malformed");
    expect(failureOf(JSON.stringify({ id: 1, instrumental: false, plainLyrics: "Line" }))).toBe(
      "malformed",
    );
  });

  it("reads a record from an LRCLIB that predates Lyricsfile", () => {
    const older = JSON.stringify({
      id: 3396226,
      trackName: "Song",
      artistName: "Artist",
      albumName: "Album",
      duration: 233,
      instrumental: false,
      plainLyrics: "Line",
      syncedLyrics: null,
    });

    expect(lyricsOf(older)).toMatchObject({ recordId: 3396226 });
  });
});
