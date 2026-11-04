import type { TableNames, Id } from "../_generated/dataModel";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/** Parses a wire ID into a document ID for `table`, or fails with `not_found`. */
export const tableId = <Table extends TableNames>(
  ctx: ReadCtx,
  table: Table,
  id: string,
): Id<Table> => ctx.db.normalizeId(table, id) ?? fail("not_found", `No ${table} with id ${id}`);
