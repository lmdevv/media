import { decidableRows } from "../core/permissions/grants";
import type { Reach } from "../core/permissions/grants";
import { readsOf } from "../movies/reads";
import type { Reads } from "../movies/reads";
import { TABLE_BYTES } from "./fit";

/**
 * What music reads cost against a query's read budget (`movies/reads.ts`, ADR 0005): one index
 * range, and each document at the bound the music writer keeps its table within (`fit.ts`), so a
 * read reserves its worst case before it runs and settles on what it returned.
 */
type Table = keyof typeof TABLE_BYTES;

/** One indexed query, or `ranges` of them, that return at most `rows` documents of `table`. */
export const rowsOf = (table: Table, rows: number, ranges = 1): Reads =>
  readsOf(ranges, rows, rows * TABLE_BYTES[table]);

/** `count` gets of `table`'s documents: a range and a document each. */
export const getsOf = (table: Table, count: number): Reads =>
  readsOf(count, count, count * TABLE_BYTES[table]);

/**
 * What presenting one track reads: whether the caller likes it, one index range and at most one
 * small row.
 */
export const LIKED_READS: Reads = rowsOf("likes", 1);

/** Rows one list page holds at most, as movies' lists do. */
const LIST_PAGE_MAX = 200;

/** The bytes one list page's rows may read: what a call may read less room for its fixed work. */
const PAGE_BYTES = 10 * 1024 * 1024;

/**
 * The rows one page of a list may hold for the caller of `reach`, when each row reads
 * `rowReads` documents of its own besides its library's grants, and `rowBytes` bytes at most: at
 * most `LIST_PAGE_MAX`, as many as `decidableRows` lets the call decide, and as many as fit in
 * `PAGE_BYTES` at their bounds, so a page never reads past Convex's limits whatever its rows hold.
 */
export const pageRowsFor = (reach: Reach, rowReads: number, rowBytes: number): number =>
  Math.max(
    1,
    Math.min(LIST_PAGE_MAX, decidableRows(reach, rowReads), Math.floor(PAGE_BYTES / rowBytes)),
  );

/** The bytes one listed track reads at most: the track, whether it is liked, and its list row. */
export const TRACK_ROW_BYTES = TABLE_BYTES.tracks + 2 * TABLE_BYTES.likes;
