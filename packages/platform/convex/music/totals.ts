import type { Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { deleteCounter, incrementCounter, readCounter } from "../core/lib/counters";
import { itemCount } from "../core/scans";

const albumsCounter = (libraryId: Id<"libraries">): string => `music.albums:${libraryId}`;

const artistsCounter = (libraryId: Id<"libraries">): string => `music.artists:${libraryId}`;

const durationCounter = (libraryId: Id<"libraries">): string => `music.duration:${libraryId}`;

/**
 * A music library's totals as old music's `libraryStats` kept them: tracks on disk, albums with a
 * track on disk, artists with such an album, and the tracks' total length.
 */
export interface Totals {
  readonly tracks: number;
  readonly albums: number;
  readonly artists: number;
  readonly durationMs: number;
}

/** How a write moved a library's album, artist, and duration totals. */
export type Moved = Omit<Totals, "tracks">;

export const nothingMoved: Moved = { albums: 0, artists: 0, durationMs: 0 };

/**
 * Moves a library's album, artist, and duration totals by `moved`, in the mutation that wrote the
 * rows. Its track total is the core's item count, which `withScanLease`, `withLibraryItems`, and
 * `purgeStep` move from the `Counted` a write reports.
 */
export const moveTotals = async (
  db: DatabaseWriter,
  libraryId: Id<"libraries">,
  moved: Moved,
): Promise<void> => {
  if (moved.albums !== 0) await incrementCounter(db, albumsCounter(libraryId), moved.albums);

  if (moved.artists !== 0) await incrementCounter(db, artistsCounter(libraryId), moved.artists);

  if (moved.durationMs !== 0) {
    await incrementCounter(db, durationCounter(libraryId), moved.durationMs);
  }
};

/** A library's totals, from four counters of at most 16 shards each. */
export const totalsOf = async (db: DatabaseReader, libraryId: Id<"libraries">): Promise<Totals> => {
  const [tracks, albums, artists, durationMs] = await Promise.all([
    itemCount(db, libraryId),
    readCounter(db, albumsCounter(libraryId)),
    readCounter(db, artistsCounter(libraryId)),
    readCounter(db, durationCounter(libraryId)),
  ]);

  return { tracks, albums, artists, durationMs };
};

/** Deletes a removed library's totals, once its purge deleted its last rows. */
export const forgetTotals = async (db: DatabaseWriter, libraryId: Id<"libraries">) => {
  await deleteCounter(db, albumsCounter(libraryId));
  await deleteCounter(db, artistsCounter(libraryId));
  await deleteCounter(db, durationCounter(libraryId));
};
