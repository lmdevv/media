import type { Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { itemCount } from "../core/scans";
import { deleteCounter, incrementCounter, readCounter } from "../core/lib/counters";

const episodesCounter = (libraryId: Id<"libraries">): string => `movies.episodes:${libraryId}`;

const filesCounter = (libraryId: Id<"libraries">): string => `movies.files:${libraryId}`;

/** How many rows of each kind a write added (positive) or deleted (negative). */
export interface Moved {
  readonly titles: number;
  readonly episodes: number;
  readonly files: number;
}

export const nothingMoved: Moved = { titles: 0, episodes: 0, files: 0 };

export const sumMoved = (moves: ReadonlyArray<Moved>): Moved =>
  moves.reduce(
    (sum, move) => ({
      titles: sum.titles + move.titles,
      episodes: sum.episodes + move.episodes,
      files: sum.files + move.files,
    }),
    nothingMoved,
  );

/**
 * Moves a library's episode and file totals by `moved`, in the mutation that wrote those rows. Its
 * title total is the core's item count, which `withScanLease` and `purgeStep` move from the
 * `Counted` a write reports.
 */
export const moveTotals = async (
  db: DatabaseWriter,
  libraryId: Id<"libraries">,
  moved: Moved,
): Promise<void> => {
  if (moved.episodes !== 0) await incrementCounter(db, episodesCounter(libraryId), moved.episodes);

  if (moved.files !== 0) await incrementCounter(db, filesCounter(libraryId), moved.files);
};

/** A library's title, episode, and file rows, from three counters of at most 16 shards each. */
export const totalsOf = async (db: DatabaseReader, libraryId: Id<"libraries">): Promise<Moved> => {
  const [titles, episodes, files] = await Promise.all([
    itemCount(db, libraryId),
    readCounter(db, episodesCounter(libraryId)),
    readCounter(db, filesCounter(libraryId)),
  ]);

  return { titles, episodes, files };
};

/** Deletes a removed library's episode and file totals, once its purge deleted its last rows. */
export const forgetTotals = async (
  db: DatabaseWriter,
  libraryId: Id<"libraries">,
): Promise<void> => {
  await deleteCounter(db, episodesCounter(libraryId));
  await deleteCounter(db, filesCounter(libraryId));
};
