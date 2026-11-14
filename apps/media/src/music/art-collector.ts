import { MUSIC_ART_IN_USE_MAX } from "@media/contracts/server-functions";
import { Clock, Duration, Effect } from "effect";

import { deleteArt, sweepArt } from "./art-store.ts";
import type { FileError } from "./music-files.ts";

const CHECK_CONCURRENCY = 4;

const GRACE = Duration.minutes(10);

/** The music tables that name artwork. */
type ArtworkTable = "tracks" | "albums" | "artists";

const TABLES: ReadonlyArray<ArtworkTable> = ["tracks", "albums", "artists"];

/** One page of the distinct artwork hashes a table uses (`music/art:hashes`). */
interface ArtHashPage {
  readonly hashes: ReadonlyArray<string>;
  readonly cursor: string;
  readonly done: boolean;
}

/** What the art collector asks the core: which artwork the catalog still names. */
export interface ArtCatalog<E> {
  /** Which of up to `MUSIC_ART_IN_USE_MAX` hashes a track, album, or artist still uses. */
  readonly inUse: (hashes: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, E>;
  /** A page of the hashes `table` uses, after `cursor`. */
  readonly hashes: (table: ArtworkTable, cursor: string | null) => Effect.Effect<ArtHashPage, E>;
}

const hashesInUse = Effect.fn("ArtCollector.hashesInUse")(function* <E>(catalog: ArtCatalog<E>) {
  const inUse = new Set<string>();

  for (const table of TABLES) {
    let cursor: string | null = null;
    let done = false;

    while (!done) {
      const page: ArtHashPage = yield* catalog.hashes(table, cursor);

      for (const hash of page.hashes) inUse.add(hash);
      ({ cursor, done } = page);
    }
  }

  return inUse;
});

/**
 * Deletes the artwork no track, album, or artist uses that is older than ten minutes, as old
 * music's collector did. Nothing is deleted when the core lists no artwork in use at all: that is
 * also what a server pointed at the wrong (or an empty) core sees, and deleted art never comes
 * back on its own, as rescans skip unchanged files. A server whose music libraries were all
 * deleted keeps its art until one uses art again.
 *
 * @returns How many files were deleted, or the catalog's error when it could not list the artwork
 *   in use, or `FileError` when the art store could not be read.
 */
export const collectUnusedArt = Effect.fn("ArtCollector.collect")(function* <E>(
  dataDir: string,
  catalog: ArtCatalog<E>,
): Effect.fn.Return<number, E | FileError> {
  const inUse = yield* hashesInUse(catalog);

  if (inUse.size === 0) return 0;

  const now = yield* Clock.currentTimeMillis;
  const removed = yield* sweepArt(dataDir, inUse, now - Duration.toMillis(GRACE));

  if (removed > 0) {
    yield* Effect.logInfo("ArtCollector.collected").pipe(Effect.annotateLogs({ removed }));
  }

  return removed;
});

/**
 * Deletes the artwork among `released` (what scan writes stopped using somewhere) that no track,
 * album, or artist uses any more and that is older than ten minutes. It asks the core about these
 * hashes only, so a scan that changed a few songs costs a few lookups rather than a walk over
 * every song, album, and artist. Art it misses goes at the next full collection.
 *
 * @returns The released hashes that are unused but younger than ten minutes, to try again after
 *   the next scan; or the catalog's error, or `FileError` when a file could not be deleted.
 */
export const collectReleasedArt = Effect.fn("ArtCollector.collectReleased")(function* <E>(
  dataDir: string,
  catalog: ArtCatalog<E>,
  released: Iterable<string>,
): Effect.fn.Return<ReadonlySet<string>, E | FileError> {
  const hashes = [...released];

  if (hashes.length === 0) return new Set();

  const checked = yield* Effect.forEach(
    Array.from({ length: Math.ceil(hashes.length / MUSIC_ART_IN_USE_MAX) }, (_, chunk) =>
      hashes.slice(chunk * MUSIC_ART_IN_USE_MAX, (chunk + 1) * MUSIC_ART_IN_USE_MAX),
    ),
    catalog.inUse,
    { concurrency: CHECK_CONCURRENCY },
  );

  const inUse = new Set(checked.flat());
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
