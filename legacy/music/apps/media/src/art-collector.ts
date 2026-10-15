/**
 * Deletes stored artwork nothing uses any more: the old cover of an album whose cover was
 * replaced, or the art of songs that are gone from every library. Convex lists the hashes its
 * tracks, albums, and artists use; everything else in the art store goes, once it is old enough
 * that no scan still on its way to Convex can be about to use it.
 */
import { ART_IN_USE_MAX } from "@music/commands/media-limits";
import { Clock, Duration, Effect } from "effect";

import { deleteArt, sweepArt } from "./art-store.ts";
import { type ArtHashPage, type ArtworkTable, MediaBackend } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";

/** `artInUse` calls in flight at once while collecting what scans released. */
const CHECK_CONCURRENCY = 4;

/** Artwork younger than this stays: a scan may have saved it and not stored its songs yet. */
const GRACE = Duration.minutes(10);

const TABLES: ReadonlyArray<ArtworkTable> = ["tracks", "albums", "artists"];

const hashesInUse = Effect.fn("ArtCollector.hashesInUse")(function* () {
  const backend = yield* MediaBackend;
  const inUse = new Set<string>();

  for (const table of TABLES) {
    let cursor: string | null = null;
    let done = false;

    while (!done) {
      const page: ArtHashPage = yield* backend.artHashes(table, cursor);

      for (const hash of page.hashes) inUse.add(hash);
      ({ cursor, done } = page);
    }
  }

  return inUse;
});

/**
 * Deletes the artwork no track, album, or artist uses that is older than ten minutes. Nothing is
 * deleted when Convex lists no artwork in use at all: that is also what a media service pointed
 * at the wrong (or an empty) deployment sees, and deleted art never comes back on its own, as
 * rescans skip unchanged files. A server whose libraries were all deleted keeps its art until
 * one uses art again.
 *
 * @returns How many files were deleted, or `BackendError` when Convex could not list the
 *   artwork in use, or `FileError` when the art store could not be read.
 */
export const collectUnusedArt = Effect.fn("ArtCollector.collect")(function* () {
  const { dataDir } = yield* MediaConfig;
  const inUse = yield* hashesInUse();

  if (inUse.size === 0) return 0;
  const now = yield* Clock.currentTimeMillis;
  const removed = yield* sweepArt(dataDir, inUse, now - Duration.toMillis(GRACE));

  if (removed > 0) {
    yield* Effect.logInfo("ArtCollector.collected").pipe(Effect.annotateLogs({ removed }));
  }

  return removed;
});

/**
 * Deletes the artwork among `released` (what scan batches stopped using somewhere) that no
 * track, album, or artist uses any more and that is older than ten minutes. It asks Convex about
 * these hashes only, so a scan that changed a few songs costs a few lookups rather than a walk
 * over every song, album, and artist. Art it misses (an album the scheduler deletes after the
 * check) goes at the next full collection.
 *
 * @returns The released hashes that are unused but younger than ten minutes, to try again after
 *   the next scan; or `BackendError` when Convex could not say which artwork is in use, or
 *   `FileError` when a file could not be deleted.
 */
export const collectReleasedArt = Effect.fn("ArtCollector.collectReleased")(function* (
  released: Iterable<string>,
) {
  const hashes = [...released];
  const none: ReadonlySet<string> = new Set();

  if (hashes.length === 0) return none;
  const backend = yield* MediaBackend;
  const { dataDir } = yield* MediaConfig;

  const checked = yield* Effect.forEach(
    Array.from({ length: Math.ceil(hashes.length / ART_IN_USE_MAX) }, (_, chunk) =>
      hashes.slice(chunk * ART_IN_USE_MAX, (chunk + 1) * ART_IN_USE_MAX),
    ),
    backend.artInUse,
    { concurrency: CHECK_CONCURRENCY },
  );

  const inUse = new Set(checked.flatMap((used) => Array.from(used)));

  const now = yield* Clock.currentTimeMillis;

  const { removed, tooNew } = yield* deleteArt(
    dataDir,
    hashes.filter((hash) => !inUse.has(hash)),
    now - Duration.toMillis(GRACE),
  );

  if (removed > 0) {
    yield* Effect.logInfo("ArtCollector.collected").pipe(Effect.annotateLogs({ removed }));
  }

  return new Set(tooNew);
});
