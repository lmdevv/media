import { Buffer } from "node:buffer";
import { join } from "node:path";

import {
  type LocalLyricSet,
  LocalLyricOrigin,
  LyricBody,
  type ScannedLyrics,
} from "@media/contracts/models/music";
import { Effect, Option, Result } from "effect";

import { decodeLyricsText } from "./lyrics/decode-text.ts";
import { MAX_LYRICS_SIZE } from "./lyrics/lyric-body.ts";
import { parseLyricsFile } from "./lyrics/lyrics-file.ts";
import {
  localLyricSets,
  type LyricsSidecar,
  lyricsFilesKey,
  type ReadSidecar,
} from "./lyrics/sidecars.ts";
import * as Files from "./music-files.ts";

/**
 * The version of the lyric readers. Raise it whenever they would read existing files
 * differently: the next scan then reads every song's lyrics again, without its tags or artwork.
 */
export const LYRICS_READER_VERSION = 1;

/**
 * The most a song's kept lyric sets take as JSON. The core's lyrics row holds 512 KiB as Convex
 * measures a document, and keeps the leading sets that fit (`fitLyrics` in `music/fit.ts`), so
 * the server chooses within that, less a margin for the two measures' difference, rather than
 * old music's own 768 KiB: the core then never drops what the server kept.
 */
const MAX_STORED_BYTES = 480 * 1024;

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

/** A lyric file beside the song beats a tag inside it. */
const originRank = (set: LocalLyricSet): number =>
  LocalLyricOrigin.guards.Sidecar(set.origin) ? 0 : 1;

/** Word timing beats line timing. */
const wordRank = (set: LocalLyricSet): number =>
  LyricBody.guards.Synced(set.body) && set.body.lines.some((line) => line.words !== null) ? 0 : 1;

/** The first set `rank` puts first, or undefined. */
const best = (
  sets: ReadonlyArray<LocalLyricSet>,
  rank: (set: LocalLyricSet) => number,
): LocalLyricSet | undefined =>
  sets.reduce<LocalLyricSet | undefined>(
    (found, set) => (found === undefined || rank(set) < rank(found) ? set : found),
    undefined,
  );

/**
 * The set a client shows from a song's own sets, as old music's `resolveLyrics` picked it without
 * LRCLIB and the core's `music.lyrics.get` picks it: its synced main lyrics, else its plain main
 * lyrics, a file beside the song beating a tag inside it, and word timing beating line timing;
 * among sets still equal, the first.
 */
const shownMain = (sets: ReadonlyArray<LocalLyricSet>): LocalLyricSet | undefined => {
  const main = sets.filter((set) => set.kind === "main");

  return (
    best(
      main.filter((set) => LyricBody.guards.Synced(set.body)),
      (set) => originRank(set) * 2 + wordRank(set),
    ) ??
    best(
      main.filter((set) => LyricBody.guards.Plain(set.body)),
      originRank,
    )
  );
};

const byPrecedence = (sets: ReadonlyArray<LocalLyricSet>): ReadonlyArray<LocalLyricSet> => {
  const main = shownMain(sets);

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

  // The set a client shows goes first, so the core's fitting, which keeps leading sets, keeps it
  // whatever else is there; the others stay in the order their files and tags gave them.
  const ordered = sets.filter((set) => kept.has(set));
  const main = shownMain(ordered);

  return {
    kept: main === undefined ? ordered : [main, ...ordered.filter((set) => set !== main)],
    dropped: sets.length - kept.size,
  };
};

/**
 * Reads a song's own lyrics: its lyric files (`lyricsSidecarMatcher`) beside it, and the lyrics
 * its tags hold (`embedded`). A lyric file that cannot be read or parsed is logged and adds no
 * lyrics; it never fails the scan.
 *
 * @returns The song's lyric files and lyric sets as `music/scanner:upsert` and
 *   `music/scanner:lyrics` store them.
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
