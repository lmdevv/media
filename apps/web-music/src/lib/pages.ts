import { useAllPages } from "@media/ui/lib/pages";
import type { PageOf, PageOpts, PagedQuery } from "@media/ui/lib/pages";
import { useState } from "react";

/** Rows a page asks for; the core caps a page to what one call may read. */
export const PAGE_ROWS = 100;

/** The last whole list a query answered, for its arguments' key. */
interface WholeList<Args, Row> {
  readonly query: PagedQuery<Args, Row>;
  readonly key: string;
  readonly rows: ReadonlyArray<Row>;
}

/**
 * Every row of a paginated core query once all its pages arrived, else `undefined`, for screens
 * that show a list whole: an album's songs, an artist's albums, a playlist's entries. While a
 * page reloads, as when the list grows past a page or a page splits, it keeps the last whole list
 * of the same query, so the screen never drops back to its skeleton. A failed page throws to the
 * route's error screen, as `useRead` does.
 */
export const useAllRows = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
): ReadonlyArray<Row> | undefined => {
  const paged = useAllPages(query, argsAt, PAGE_ROWS);
  const key = JSON.stringify(argsAt({ numItems: PAGE_ROWS, cursor: null }));
  const [last, setLast] = useState<WholeList<Args, Row> | null>(null);

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status === "ready" && paged.next.kind === "failed") throw new Error(paged.next.message);

  const whole = paged.status === "ready" && paged.next.kind === "done" ? paged.rows : undefined;

  if (whole !== undefined) {
    if (last?.rows !== whole) setLast({ query, key, rows: whole });

    return whole;
  }

  return last !== null && last.query === query && last.key === key ? last.rows : undefined;
};

/**
 * Reads a paginated core query once, page after page, until it ends or holds `max` rows. Each
 * request needs the previous page's cursor, so pages load one after another.
 */
export const readPages = async <Row>(
  read: (paginationOpts: PageOpts) => Promise<PageOf<Row>>,
  max: number,
): Promise<ReadonlyArray<Row>> => {
  const collect = async (
    cursor: string | null,
    loaded: ReadonlyArray<Row>,
  ): Promise<ReadonlyArray<Row>> => {
    const page = await read({ numItems: PAGE_ROWS, cursor });

    if (!page.isDone && page.continueCursor === cursor) {
      throw new Error("The list stopped advancing; load it again");
    }

    const rows = [...loaded, ...page.page];

    return page.isDone || rows.length >= max
      ? rows.slice(0, max)
      : collect(page.continueCursor, rows);
  };

  return collect(null, []);
};
