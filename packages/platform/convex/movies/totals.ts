import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { itemCount } from "../core/scans";
import { deleteCounter, incrementCounter, readCounter } from "../core/lib/counters";

const episodesCounter = (libraryId: Id<"libraries">): string => `movies.episodes:${libraryId}`;

const filesCounter = (libraryId: Id<"libraries">): string => `movies.files:${libraryId}`;

const missingCounter = (libraryId: Id<"libraries">): string => `movies.missing:${libraryId}`;

const unmatchedCounter = (libraryId: Id<"libraries">): string => `movies.unmatched:${libraryId}`;

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

/** Deletes a removed library's totals, once its purge deleted its last rows. */
export const forgetTotals = async (
  db: DatabaseWriter,
  libraryId: Id<"libraries">,
): Promise<void> => {
  await deleteCounter(db, episodesCounter(libraryId));
  await deleteCounter(db, filesCounter(libraryId));
  await deleteCounter(db, missingCounter(libraryId));
  await deleteCounter(db, unmatchedCounter(libraryId));
};

type Counted<Table extends "mediaFiles" | "titles"> = Pick<
  Doc<Table>,
  Table extends "mediaFiles" ? "libraryId" | "missing" : "libraryId" | "matchStatus" | "purging"
>;

const step = (before: boolean, after: boolean): number => Number(after) - Number(before);

/**
 * Moves a library's missing-file total as one file changes from `before` to `after`, null for a
 * row inserted or deleted. The movies writer calls it on every write of a file and the purge on
 * every delete, in the same mutation, so the total is exact (D28). A file never changes library.
 */
export const countMissing = async (
  db: DatabaseWriter,
  before: Counted<"mediaFiles"> | null,
  after: Counted<"mediaFiles"> | null,
): Promise<void> => {
  const row = after ?? before;
  const delta = step(before?.missing === true, after?.missing === true);

  if (row !== null && delta !== 0) await incrementCounter(db, missingCounter(row.libraryId), delta);
};

const unmatched = (title: Counted<"titles"> | null): boolean =>
  title !== null && title.matchStatus === "unmatched" && title.purging !== true;

/**
 * Moves a library's unmatched-title total as one title changes from `before` to `after`, null for
 * one inserted. A title leaves the total when it is marked `purging`, before the purge deletes it,
 * as it leaves every other read. A title never changes library.
 */
export const countUnmatched = async (
  db: DatabaseWriter,
  before: Counted<"titles"> | null,
  after: Counted<"titles">,
): Promise<void> => {
  const delta = step(unmatched(before), unmatched(after));

  if (delta !== 0) await incrementCounter(db, unmatchedCounter(after.libraryId), delta);
};

/** A library's missing files and unmatched titles, from two counters of at most 16 shards each. */
export const problemsOf = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
): Promise<{ readonly missing: number; readonly unmatched: number }> => {
  const [missing, unmatchedTitles] = await Promise.all([
    readCounter(db, missingCounter(libraryId)),
    readCounter(db, unmatchedCounter(libraryId)),
  ]);

  return { missing, unmatched: unmatchedTitles };
};
