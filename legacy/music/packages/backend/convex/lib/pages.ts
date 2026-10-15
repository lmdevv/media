/**
 * Pages over several sorted index ranges at once. A member who reads two libraries pages through
 * those two libraries' indexes merged, instead of through every library's rows filtered after the
 * fact, so another user's large private library costs them nothing and never yields empty pages.
 *
 * Convex allows one `paginate` per function, so pages are cut by key: a cursor is the sort key and
 * creation time of the last row a page returned, and the next page starts strictly after it. A
 * page that also gets `end` (the next page's cursor) returns everything up to it, so pages already
 * on screen keep their ranges while rows are added or removed.
 */
import { compareText } from "@music/commands/text-order";
import { Option, Predicate, Schema } from "effect";

import { fail } from "./errors";

/** A position in a list sorted by a key, then by creation time. */
export interface Bound {
  readonly key: string | number;
  readonly time: number;
}

/** Which rows a source reads: strictly after `start`, up to and including `end`. */
export interface Range {
  readonly start: Bound | null;
  readonly end: Bound | null;
}

/** Reads up to `limit` rows of `range`, in list order. */
export type Source<Row> = (range: Range, limit: number) => Promise<ReadonlyArray<Row>>;

/** What a list command takes: where the page starts, where it stops, and how many it holds. */
export interface PageRequest {
  readonly cursor?: string | null | undefined;
  readonly end?: string | null | undefined;
  readonly limit?: number | undefined;
}

/** One page of a list, ready for the wire. */
export interface Page<Row> {
  readonly items: ReadonlyArray<Row>;
  readonly cursor: string;
  readonly done: boolean;
}

const DEFAULT_LIMIT = 50;

/**
 * Most rows a page with an `end` returns. Pages grow when rows land in their range; past this the
 * page ends at its last row and reports that as its cursor, so the client inserts a page there.
 */
const MAX_SPAN = 1000;

const invalidCursor = (): never =>
  fail("invalid_args", "That page cursor is not valid here; load the list again");

/** The key of a bound in a list sorted by a number. */
export const numberKey = (bound: Bound): number =>
  Predicate.isNumber(bound.key) ? bound.key : invalidCursor();

/** The key of a bound in a list sorted by text. */
export const textKey = (bound: Bound): string =>
  Predicate.isString(bound.key) ? bound.key : invalidCursor();

/** A cursor on the wire: the JSON pair `[key, creation time]`. */
const Cursor = Schema.fromJsonString(
  Schema.Tuple([Schema.Union([Schema.String, Schema.Finite]), Schema.Finite]),
);

const decodeWire = Schema.decodeUnknownOption(Cursor);

const encodeWire = Schema.encodeSync(Cursor);

/** Encodes where a page ended. */
const encodeCursor = (bound: Bound): string => encodeWire([bound.key, bound.time]);

/** Parses a cursor from a client; an empty or missing one means the start of the list. */
const decodeCursor = (cursor: string | null | undefined): Bound | null => {
  if (cursor === undefined || cursor === null || cursor === "") return null;

  return Option.match(decodeWire(cursor), {
    onNone: invalidCursor,
    onSome: ([key, time]) => ({ key, time }),
  });
};

const compareKeys = (left: string | number, right: string | number): number =>
  Predicate.isString(left) && Predicate.isString(right)
    ? compareText(left, right)
    : Number(left) - Number(right);

/** Orders rows by key, then creation time, ascending or descending. */
const comparing =
  <Row extends { readonly _creationTime: number }>(
    keyOf: (row: Row) => string | number,
    direction: "asc" | "desc",
  ) =>
  (left: Row, right: Row): number => {
    const leftKey = keyOf(left);
    const rightKey = keyOf(right);

    const byKey = compareKeys(leftKey, rightKey) || left._creationTime - right._creationTime;

    return direction === "asc" ? byKey : -byKey;
  };

/**
 * Reads one page from the merged sources. Each source returns its rows in list order; the page is
 * the first `limit` rows of all of them together, or every row up to `end` when it is given.
 */
export const mergedPage = async <Row extends { readonly _creationTime: number }>(
  sources: ReadonlyArray<Source<Row>>,
  keyOf: (row: Row) => string | number,
  direction: "asc" | "desc",
  request: PageRequest,
): Promise<Page<Row>> => {
  const range = { start: decodeCursor(request.cursor), end: decodeCursor(request.end) };
  const limit = range.end === null ? (request.limit ?? DEFAULT_LIMIT) : MAX_SPAN;
  // One more than the page holds tells whether anything follows it.
  const read = await Promise.all(sources.map((source) => source(range, limit + 1)));
  const merged = read.flat().toSorted(comparing(keyOf, direction));
  const items = merged.slice(0, limit);
  const last = items.at(-1);

  if (range.end !== null) {
    // A page that outgrew `MAX_SPAN` ends at its last row instead, and the client puts a page
    // starting there in front of the one at `end`.
    return {
      items,
      cursor:
        merged.length > limit && last !== undefined
          ? encodeCursor({ key: keyOf(last), time: last._creationTime })
          : encodeCursor(range.end),
      done: false,
    };
  }

  return {
    items,
    cursor:
      last === undefined
        ? (request.cursor ?? "")
        : encodeCursor({ key: keyOf(last), time: last._creationTime }),
    done: merged.length <= limit,
  };
};
