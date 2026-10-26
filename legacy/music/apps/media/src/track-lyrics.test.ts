import { join } from "node:path";

import {
  type LocalLyricSet,
  type LyricLine,
  LyricsLookup,
  parseLang,
  resolveLyrics,
} from "@music/commands/lyrics";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import * as Files from "./files.ts";
import { temporaryDirectory } from "./testing/fixtures.ts";
import { runScoped } from "./testing/run.ts";
import { readTrackLyrics } from "./track-lyrics.ts";

const encoder = new TextEncoder();

/** `count` LRC lines half a second apart, each about 100 characters long. */
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

const shown = (sets: ReadonlyArray<LocalLyricSet>) =>
  resolveLyrics(sets, LyricsLookup.None(), { remoteLookups: "off" });

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

        expect(lyrics).toEqual([first, synced]);
        expect(shown(lyrics)).toMatchObject({ _tag: "Synced", main: synced });
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
          ["translation", { _tag: "Sidecar", fileName: "Song.de.lrc", format: "lrc" }],
          ["main", main.origin],
        ]);
        expect(shown(lyrics)).toMatchObject({ _tag: "Plain", main });
      }),
    ));
});
