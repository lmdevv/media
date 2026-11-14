import { join } from "node:path";

import {
  type LocalLyricSet,
  LocalLyricOrigin,
  LyricBody,
  type LyricLine,
  parseLang,
} from "@media/contracts/models/music";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import * as Files from "./music-files.ts";
import { runScoped, temporaryDirectory } from "./testing/music-fixtures.ts";
import { readTrackLyrics } from "./track-lyrics.ts";

const encoder = new TextEncoder();

const lrc = (count: number): string =>
  Array.from({ length: count }, (_, index) => {
    const ms = index * 500;
    const minutes = String(Math.floor(ms / 60_000)).padStart(2, "0");
    const seconds = ((ms % 60_000) / 1000).toFixed(2).padStart(5, "0");

    return `[${minutes}:${seconds}]Line ${index} ${"la ".repeat(33)}`.trimEnd();
  }).join("\n");

const plainTag = (tag: "vorbis:LYRICS" | "vorbis:UNSYNCEDLYRICS", text: string): LocalLyricSet => ({
  kind: "main",
  lang: parseLang("en"),
  origin: { _tag: "Embedded", tag },
  body: { _tag: "Plain", text },
});

const line = (index: number): LyricLine => ({
  text: `Line ${index} ${"la ".repeat(33)}`.trimEnd(),
  startMs: index * 500,
  endMs: null,
  words: null,
  voice: null,
});

/**
 * What a client shows of `sets`, as the core's `music.lyrics.get` picks it: the first synced main
 * set, a file's before a tag's, else the first plain one. Enough for these sets, which never tie.
 */
/** A lyric file beside the song beats a tag inside it. */
const originRank = (set: LocalLyricSet): number =>
  LocalLyricOrigin.guards.Sidecar(set.origin) ? 0 : 1;

const firstByOrigin = (sets: ReadonlyArray<LocalLyricSet>): LocalLyricSet | undefined =>
  sets.toSorted((a, b) => originRank(a) - originRank(b))[0];

/**
 * What a client shows of `sets`, as the core's `music.lyrics.get` picks it: the first synced main
 * set, a file's before a tag's, else the first plain one. Enough for these sets, which never tie.
 */
const shown = (sets: ReadonlyArray<LocalLyricSet>) => {
  const main = sets.filter((set) => set.kind === "main");
  const synced = firstByOrigin(main.filter((set) => LyricBody.guards.Synced(set.body)));
  const plain = firstByOrigin(main.filter((set) => LyricBody.guards.Plain(set.body)));

  if (synced !== undefined) return { _tag: "Synced", main: synced };

  return plain === undefined ? { _tag: "None" } : { _tag: "Plain", main: plain };
};

describe("readTrackLyrics", () => {
  it("keeps the synced lyrics a song shows when its tags hold more than a song may store", () =>
    runScoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("lyrics");

        const synced: LocalLyricSet = {
          kind: "main",
          lang: null,
          origin: { _tag: "Embedded", tag: "vorbis:SYNCEDLYRICS" },
          body: {
            _tag: "Synced",
            lines: [line(0), ...Array.from({ length: 1999 }, (_, index) => line(index + 1))],
          },
        };

        const first = plainTag("vorbis:UNSYNCEDLYRICS", "a".repeat(250_000));
        const second = plainTag("vorbis:LYRICS", "b".repeat(250_000));

        expect(shown([first, second, synced])).toMatchObject({ _tag: "Synced" });
        const { lyrics } = yield* readTrackLyrics(root, [], [first, second, synced]);

        // The synced set comes first, and what is kept fits the core's 512 KiB lyrics row.
        expect(lyrics).toEqual([synced]);
        expect(shown(lyrics)).toMatchObject({ _tag: "Synced", main: synced });
        expect(new TextEncoder().encode(JSON.stringify(lyrics)).length).toBeLessThan(480 * 1024);
      }),
    ));

  it("keeps a song's main lyrics before translations beside it", () =>
    runScoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("lyrics");
        const main = plainTag("vorbis:LYRICS", "Main words\n".repeat(10_000).trim());

        const sidecars = yield* Effect.forEach(["de", "fr"], (lang) =>
          Effect.gen(function* () {
            const relativePath = `Song.${lang}.lrc`;
            const bytes = encoder.encode(lrc(2000));

            yield* Files.writeFileAtomic(join(root, relativePath), bytes, "x");

            return {
              file: { relativePath, size: bytes.length, mtimeMs: 1 },
              format: "lrc" as const,
              lang: parseLang(lang),
            };
          }),
        );

        const { lyrics } = yield* readTrackLyrics(root, sidecars, [main]);

        expect(lyrics.map((set) => [set.kind, set.origin])).toEqual([
          ["main", main.origin],
          ["translation", { _tag: "Sidecar", fileName: "Song.de.lrc", format: "lrc" }],
        ]);
        expect(shown(lyrics)).toMatchObject({ _tag: "Plain", main });
      }),
    ));
});
