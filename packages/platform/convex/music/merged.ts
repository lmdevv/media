import type { PaginationOptions, PaginationResult } from "convex/server";
import { compareValues } from "convex/values";
import type { Value } from "convex/values";

import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { pageRows } from "../core/lib/paginate";
import type { ItemGate, Reach } from "../core/permissions/grants";
import { callBudget, readsOf, settleRead, times } from "../movies/reads";
import type { ReadBudget, Reads } from "../movies/reads";
import { libraryGates, walkMusicLibraries } from "./access";
import { DOCUMENT_BYTES } from "./fit";
import { LIST_PAGE_MAX, pageRowsFor } from "./reads";

/**
 * The album, artist, and song lists over every music library a person may see, in one order, as
 * old music merged them when it fixed ADS-112: a page reads only the libraries the caller may
 * read, each through its own index, and merges them by the list's key and each row's tie, so a
 * library they cannot see costs them nothing and never leaves them an empty page (ADR 0005).
 *
 * The cursor is the key and the tie of the last row a page went past, as `key|tie`; a tie is a
 * UUID, so the last `|` divides them whatever the key holds. A tie is unique to its row
 * across every library, so that one position names one exact place in every library's index:
 * each page starts strictly after it in each library, and no row is skipped or repeated however
 * rows come and go between pages. Each library costs its index ranges on the call's read budget,
 * one or two a read, so a page costs what the caller's own libraries hold. A caller who sees more
 * libraries than one call can walk or read pages the household-wide index and decides each row,
 * on the same cursor, as these lists did before.
 */

/** A list's sort key: text or a number, in Convex's index order. */
type Key = string | number;

/** Where a list stands: the key and the tie of the last row a page went past. */
interface Position<K extends Key> {
  readonly key: K;
  readonly tie: string;
}

/**
 * A row of a list over libraries, a document Convex measures: each carries a tie unique across
 * them (ADR 0005).
 */
type Listed = Record<string, Value> & {
  readonly libraryId: Id<"libraries">;
  readonly tie: string;
};

/** The two index ranges a list reads after a position, in its order, at most `count` rows each. */
export interface Ranges<Row, K extends Key> {
  /** Rows at `key` whose tie comes after `tie`. */
  readonly atKey: (key: K, tie: string, count: number) => Promise<ReadonlyArray<Row>>;
  /** Rows whose key comes after `key`, or every row from the start when it is null. */
  readonly pastKey: (key: K | null, count: number) => Promise<ReadonlyArray<Row>>;
}

/** One list over libraries: its order, its indexes, and what showing a row takes. */
export interface LibraryList<Row extends Listed, K extends Key> {
  readonly order: "asc" | "desc";
  readonly key: (row: Row) => K;
  /** A cursor's key as this list's, or null when it is not one. */
  readonly keyFrom: (text: string) => K | null;
  /** The most bytes one row takes, as its writer keeps it (`fit.ts`). */
  readonly rowBytes: number;
  /** One library's rows, through its own index. */
  readonly inLibrary: (libraryId: Id<"libraries">) => Ranges<Row, K>;
  /** Every library's rows, through the household-wide index. */
  readonly everywhere: Ranges<Row, K>;
  /** Whether a row shows, given the caller's gate on its library. */
  readonly shows: (row: Row, gate: ItemGate) => boolean;
  /** What showing one row reads besides it, which the caller reads after the page. */
  readonly shown: Reads;
  /** What one row reads in the household-wide index besides its library's grants. */
  readonly rowReads: number;
}

/** The share of a page's read budget that walking the caller's libraries may spend. */
const WALK_SHARE = 0.25;

/**
 * Libraries one page merges at most. Reading each once costs two ranges and a row at its bound;
 * a caller who sees more pages the household-wide index instead.
 */
const MERGED_LIBRARIES_MAX = 100;

const NOT_THIS_LIST = "This page cursor did not come from this list";

/** What divides a cursor's key from its tie. */
const DIVIDER = "|";

const positionOf = <Row extends Listed, K extends Key>(
  list: LibraryList<Row, K>,
  cursor: string | null | undefined,
): Position<K> | null => {
  if (cursor === undefined || cursor === null || cursor === "") return null;

  const at = cursor.lastIndexOf(DIVIDER);
  const key = at < 0 ? null : list.keyFrom(cursor.slice(0, at));

  return key === null ? fail("invalid_args", NOT_THIS_LIST) : { key, tie: cursor.slice(at + 1) };
};

const cursorOf = <K extends Key>(position: Position<K> | null): string =>
  position === null ? "" : `${String(position.key)}${DIVIDER}${position.tie}`;

/** What a merge went past, in list order, and whether nothing is left after it. */
interface Merged<Row> {
  readonly rows: ReadonlyArray<Row>;
  /** No row is left after `rows`: up to the page's end cursor when it has one, else at all. */
  readonly complete: boolean;
}

/** One source of a merge: rows read and not yet taken, and how far it has read. */
interface Stream<Row, K extends Key> {
  readonly ranges: Ranges<Row, K>;
  readonly rows: ReadonlyArray<Row>;
  /** The last row read, or where the page started when none was. */
  readonly last: Position<K> | null;
  /** Read to its end, or past the page's end cursor. */
  readonly ended: boolean;
}

/** One merge's list, budget, and bounds. */
interface Merge<Row extends Listed, K extends Key> {
  readonly list: LibraryList<Row, K>;
  readonly budget: ReadBudget;
  readonly through: Position<K> | null;
  /** Rows the page goes past at most. */
  readonly rows: number;
}

const placeOf = <Row extends Listed, K extends Key>(
  list: LibraryList<Row, K>,
  row: Row,
): Position<K> => ({ key: list.key(row), tie: row.tie });

/** Negative when `one` comes first in the list. */
const comparing =
  <Row extends Listed, K extends Key>(list: LibraryList<Row, K>) =>
  (one: Position<K>, other: Position<K>): number =>
    (list.order === "asc" ? 1 : -1) *
    (compareValues(one.key, other.key) || compareValues(one.tie, other.tie));

/** Reading up to `count` rows of a source: two index ranges, and each row at its bound. */
const readCost = (rowBytes: number, count: number): Reads => readsOf(2, count, count * rowBytes);

/** Rows a refill may reserve, keeping half the budget's bytes for what comes after. */
const affordable = (budget: ReadBudget, rowBytes: number): number =>
  Math.floor(budget.left().bytes / 2 / rowBytes);

/**
 * Reads up to `count` rows of `ranges` strictly after `from`, which `reserved` paid for, and
 * settles the budget on what came back.
 */
const readStream = async <Row extends Listed, K extends Key>(
  merge: Merge<Row, K>,
  ranges: Ranges<Row, K>,
  from: Position<K> | null,
  count: number,
  reserved: Reads,
): Promise<Stream<Row, K>> => {
  const { list, budget, through } = merge;
  const same = from === null ? [] : await ranges.atKey(from.key, from.tie, count);

  const past =
    same.length === count ? [] : await ranges.pastKey(from?.key ?? null, count - same.length);

  const found = [...same, ...past];

  settleRead(budget, reserved, found);

  if (from === null || same.length === count) budget.settle(readsOf(1, 0, 0));

  const compare = comparing(list);

  const rows =
    through === null ? found : found.filter((row) => compare(placeOf(list, row), through) <= 0);

  const lastRow = found.at(-1);
  const last = lastRow === undefined ? from : placeOf(list, lastRow);

  // A source has nothing more for the page once it read to its end or reached the end cursor.
  const reachedEnd = through !== null && last !== null && compare(last, through) >= 0;

  return { ranges, rows, last, ended: found.length < count || reachedEnd };
};

/**
 * Takes rows from the streams in list order up to the frontier, the least of the open streams'
 * last rows: no unread row of any stream comes before it. When the page is not full, the stream
 * at the frontier has had every row it read taken, so it reads on, and the frontier moves.
 */
const step = async <Row extends Listed, K extends Key>(
  merge: Merge<Row, K>,
  streams: ReadonlyArray<Stream<Row, K>>,
  page: ReadonlyArray<Row>,
): Promise<Merged<Row>> => {
  const { list, budget } = merge;
  const compare = comparing(list);

  const frontier = streams.reduce<Position<K> | null>(
    (least, stream) =>
      stream.ended || stream.last === null || (least !== null && compare(least, stream.last) <= 0)
        ? least
        : stream.last,
    null,
  );

  const ready = streams
    .flatMap((stream, index) =>
      stream.rows
        .filter((row) => frontier === null || compare(placeOf(list, row), frontier) <= 0)
        .map((row) => ({ row, index })),
    )
    .toSorted((one, other) => compare(placeOf(list, one.row), placeOf(list, other.row)));

  const taken = ready.slice(0, merge.rows - page.length);

  const left: ReadonlyArray<Stream<Row, K>> = streams.map((stream, index) => ({
    ...stream,
    rows: stream.rows.slice(taken.filter((one) => one.index === index).length),
  }));

  const went = [...page, ...taken.map((one) => one.row)];
  const drained = left.every((stream) => stream.ended && stream.rows.length === 0);

  if (went.length >= merge.rows || drained) return { rows: went, complete: drained };

  const at = left.findIndex(
    (stream) =>
      !stream.ended &&
      stream.last !== null &&
      frontier !== null &&
      compare(stream.last, frontier) === 0,
  );

  const stream = left[at];
  const count = Math.min(merge.rows - went.length + 1, affordable(budget, list.rowBytes));
  const cost = readCost(list.rowBytes, count);

  if (stream === undefined || count < 1 || !budget.take(cost)) {
    return { rows: went, complete: false };
  }

  const read = await readStream(merge, stream.ranges, stream.last, count, cost);

  return step(merge, left.with(at, read), went);
};

/**
 * Merges `sources` from `after`: reads each once, as many rows each as the budget's bytes allow
 * up to a page, then steps. Null, having read nothing, when the budget cannot pay for reading
 * every source once.
 */
const merged = async <Row extends Listed, K extends Key>(
  merge: Merge<Row, K>,
  sources: ReadonlyArray<Ranges<Row, K>>,
  after: Position<K> | null,
): Promise<Merged<Row> | null> => {
  const { list, budget } = merge;

  if (sources.length === 0) return { rows: [], complete: true };

  // Each source reads a whole page when the budget's bytes allow, so a page from a few
  // libraries rarely reads one again: each index read costs its range whatever it returns. The
  // reservation is at each row's bound and settles at its real size before the next read.
  const count = Math.min(
    merge.rows + 1,
    Math.floor(budget.left().bytes / (sources.length * list.rowBytes)),
  );

  const each = readCost(list.rowBytes, count);

  if (count < 1 || !budget.take(times(each, sources.length))) return null;

  const streams = await Promise.all(
    sources.map(async (ranges) => readStream(merge, ranges, after, count, each)),
  );

  return step(merge, streams, []);
};

/** A page of the rows a merge went past that show, and where the next page starts. */
const pageOf = <Row extends Listed, K extends Key>(
  list: LibraryList<Row, K>,
  went: Merged<Row>,
  shown: ReadonlyArray<Row>,
  after: Position<K> | null,
  through: Position<K> | null,
): PaginationResult<Row> => {
  const lastRow = went.rows.at(-1);
  const last = lastRow === undefined ? after : placeOf(list, lastRow);

  if (through === null) {
    return { page: [...shown], isDone: went.complete, continueCursor: cursorOf(last) };
  }

  // A page reloaded up to its end cursor holds every row up to it, or asks to be split where
  // this call stopped, as `visiblePage` does.
  return went.complete
    ? { page: [...shown], isDone: false, continueCursor: cursorOf(through) }
    : {
        page: [...shown],
        isDone: false,
        continueCursor: cursorOf(through),
        splitCursor: cursorOf(last),
        pageStatus: "SplitRequired",
      };
};

/**
 * One page of `list` for the caller of `reach`, with only the rows that show: merged across the
 * music libraries they may read when one call can walk and read them all, else from the
 * household-wide index with each row decided. Either way the call reserves what showing each row
 * reads (`list.shown`), so the caller presents the page within Convex's limits.
 */
export const libraryPage = async <Row extends Listed, K extends Key>(
  db: DatabaseReader,
  reach: Reach,
  list: LibraryList<Row, K>,
  options: PaginationOptions,
): Promise<PaginationResult<Row>> => {
  const after = positionOf(list, options.cursor);
  const through = positionOf(list, options.endCursor);
  const budget = callBudget(reach);
  const walked = await walkMusicLibraries(db, reach, budget.part(WALK_SHARE));

  const wanted =
    through === null ? Math.min(pageRows(options.numItems), LIST_PAGE_MAX) : LIST_PAGE_MAX;

  const reserve = times(list.shown, wanted);

  if (walked.complete && walked.gates.length <= MERGED_LIBRARIES_MAX && budget.take(reserve)) {
    const gates = new Map(walked.gates.map((gate) => [gate.library._id, gate]));

    const went = await merged(
      { list, budget, through, rows: wanted },
      walked.gates.map((gate) => list.inLibrary(gate.library._id)),
      after,
    );

    if (went !== null) {
      const shown = went.rows.filter((row) => {
        const gate = gates.get(row.libraryId);

        return gate !== undefined && list.shows(row, gate);
      });

      return pageOf(list, went, shown, after, through);
    }

    budget.settle(reserve);
  }

  // A page that decides each row reads its library and the library's grants for each, so it
  // holds as many rows as `pageRowsFor` lets it decide and show within a page's reads.
  const rows = Math.min(
    wanted,
    pageRowsFor(reach, list.rowReads, list.rowBytes + list.shown.bytes + DOCUMENT_BYTES.small),
  );

  const went = await merged({ list, budget, through, rows }, [list.everywhere], after);

  // The walk spends at most a quarter of the budget and the merge gave back what it reserved, so
  // one read of the household-wide index always fits; a page that could not make one would leave
  // its caller asking for the same page forever.
  if (went === null) throw new Error("A music list could not pay for one read of its index");

  const gates = libraryGates(db, reach, "view");

  const decided = await Promise.all(
    went.rows.map(async (row) => {
      const gate = await gates(row.libraryId);

      return gate !== null && list.shows(row, gate) ? [row] : [];
    }),
  );

  return pageOf(list, went, decided.flat(), after, through);
};
