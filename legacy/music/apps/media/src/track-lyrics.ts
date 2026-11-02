import { Buffer } from "node:buffer";
import { join } from "node:path";

import {
  type LocalLyricSet,
  LyricBody,
  LyricsLookup,
  resolveLyrics,
  TrackLyrics,
} from "@music/commands/lyrics";
import { Effect, Equal, Option, Result } from "effect";

import * as Files from "./files.ts";
import { decodeLyricsText } from "./lyrics/decode-text.ts";
import { MAX_LYRICS_SIZE } from "./lyrics/lyric-body.ts";
import { parseLyricsFile } from "./lyrics/lyrics-file.ts";
import {
  localLyricSets,
  type LyricsSidecar,
  lyricsFilesKey,
  type ReadSidecar,
} from "./lyrics/sidecars.ts";
import type { ScannedLyrics } from "./media-backend.ts";

/**
 * The version of the lyric readers. Raise it whenever they would read existing files
 * differently: the next scan then reads every song's lyrics again, without its tags or artwork.
 */
export const LYRICS_READER_VERSION = 1;

const MAX_STORED_BYTES = 768 * 1024;

const CONVEX_ARRAY_MAX = 8192;

const fitsConvexArrays = LyricBody.match({
  Plain: () => true,
  Synced: ({ lines }) => lines.every((line) => (line.words?.length ?? 0) <= CONVEX_ARRAY_MAX),
});

const readSidecar = (libraryRoot: string, sidecar: LyricsSidecar): Effect.Effect<ReadSidecar> =>
  Effect.gen(function* () {
    const inside = yield* Files.resolveWithin(
      libraryRoot,
      join(libraryRoot, sidecar.file.relativePath),
    );

    if (Option.isNone(inside)) {
      yield* Effect.logWarning("Scan.lyrics_outside_library");

      return { sidecar, sets: [] };
    }

    const bytes = yield* Files.readHead(inside.value, MAX_LYRICS_SIZE + 1);

    const parsed = Result.flatMap(decodeLyricsText(bytes), (text) =>
      parseLyricsFile(sidecar.format, text, sidecar.lang),
    );

    if (Result.isFailure(parsed)) {
      yield* Effect.logWarning("Scan.lyrics_unreadable", parsed.failure);

      return { sidecar, sets: [] };
    }

    return { sidecar, sets: parsed.success };
  }).pipe(
    Effect.catchTag("FileError", (error) =>
      Effect.logWarning("Scan.lyrics_unreadable", error).pipe(Effect.as({ sidecar, sets: [] })),
    ),
    Effect.annotateLogs({ path: sidecar.file.relativePath }),
  );

const byPrecedence = (sets: ReadonlyArray<LocalLyricSet>): ReadonlyArray<LocalLyricSet> => {
  const shown = resolveLyrics(sets, LyricsLookup.None(), { remoteLookups: "off" });

  const main =
    TrackLyrics.guards.Synced(shown) || TrackLyrics.guards.Plain(shown)
      ? sets.find((set) => Equal.equals(set, shown.main))
      : undefined;

  return main === undefined ? sets : [main, ...byPrecedence(sets.filter((set) => set !== main))];
};

const storable = (sets: ReadonlyArray<LocalLyricSet>) => {
  const kept = new Set<LocalLyricSet>();
  let bytes = 2;

  for (const set of byPrecedence(sets)) {
    const size = Buffer.byteLength(JSON.stringify(set)) + (kept.size > 0 ? 1 : 0);

    if (fitsConvexArrays(set.body) && bytes + size <= MAX_STORED_BYTES) {
      kept.add(set);
      bytes += size;
    }
  }

  return { kept: sets.filter((set) => kept.has(set)), dropped: sets.length - kept.size };
};

/**
 * Reads a song's own lyrics: its lyric files (`lyricsSidecarMatcher`) beside it, and the lyrics
 * its tags hold (`embedded`). A lyric file that cannot be read or parsed is logged and adds no
 * lyrics; it never fails the scan.
 *
 * @returns The song's lyric files and lyric sets as `media:upsertTracks` and
 *   `media:saveLocalLyrics` store them.
 */
export const readTrackLyrics = Effect.fn("TrackLyrics.read")(function* (
  libraryRoot: string,
  sidecars: ReadonlyArray<LyricsSidecar>,
  embedded: ReadonlyArray<LocalLyricSet>,
) {
  const read = yield* Effect.forEach(sidecars, (sidecar) => readSidecar(libraryRoot, sidecar));

  const { kept, dropped } = storable(localLyricSets(read, embedded));

  if (dropped > 0) yield* Effect.logWarning("Scan.lyrics_too_large", { dropped });

  const lyrics: Omit<ScannedLyrics, "path"> = {
    lyricsFiles: lyricsFilesKey(sidecars),
    lyricsReader: LYRICS_READER_VERSION,
    lyrics: kept,
  };

  return lyrics;
});
