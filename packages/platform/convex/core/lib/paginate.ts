import type {
  IndexNames,
  IndexRange,
  IndexRangeBuilder,
  NamedIndex,
  NamedTableInfo,
  PaginationOptions,
  PaginationResult,
} from "convex/server";

import type { DataModel, Doc, TableNames } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";

/**
 * One Convex call may read at most 32,000 documents (ADR 0013), so a page stays far inside that
 * and leaves room for the rest of the call.
 */
export const PAGE_ROWS_MAX = 1000;

type TableInfo<Table extends TableNames> = NamedTableInfo<DataModel, Table>;

export interface IndexedList<Table extends TableNames, Index extends IndexNames<TableInfo<Table>>> {
  readonly table: Table;
  readonly index: Index;
  readonly range?: (
    q: IndexRangeBuilder<Doc<Table>, NamedIndex<TableInfo<Table>, Index>>,
  ) => IndexRange;
  readonly order?: "asc" | "desc";
}

const pageRows = (requested: number): number =>
  Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), PAGE_ROWS_MAX)
    : PAGE_ROWS_MAX;

/**
 * Reads one page of a list by index, so no list call scans a table (ADR 0013). The page holds at
 * most `PAGE_ROWS_MAX` rows, and the call reads at most `PAGE_ROWS_MAX` rows, or the caller's
 * `maximumRowsRead` when that is smaller. A page that a reactive client reloads up to its
 * `endCursor` may grow past `numItems` rows that way; past `PAGE_ROWS_MAX`, Convex asks the
 * client to split it.
 */
export const paginate = <Table extends TableNames, Index extends IndexNames<TableInfo<Table>>>(
  db: DatabaseReader,
  list: IndexedList<Table, Index>,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<Table>>> => {
  const numItems = pageRows(options.numItems);

  return db
    .query(list.table)
    .withIndex(list.index, list.range)
    .order(list.order ?? "asc")
    .paginate({
      ...options,
      numItems,
      maximumRowsRead: Math.min(options.maximumRowsRead ?? PAGE_ROWS_MAX, PAGE_ROWS_MAX),
    });
};
