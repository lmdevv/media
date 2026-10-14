/**
 * Deletes stored artwork nothing uses any more: the old cover of an album whose cover was
 * replaced, or the art of songs that are gone from every library. Convex lists the hashes its
 * tracks, albums, and artists use; everything else in the art store goes, once it is old enough
 * that no scan still on its way to Convex can be about to use it.
 */
import { Clock, Duration, Effect } from "effect";

import { sweepArt } from "./art-store.ts";
import { type ArtHashPage, type ArtworkTable, MediaBackend } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";

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
