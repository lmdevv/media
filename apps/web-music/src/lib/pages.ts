import { pagedStore } from "@media/ui/lib/pages";
import type { PageOf, PageOpts, PagedQuery, Paged } from "@media/ui/lib/pages";
import { useEffect, useState, useSyncExternalStore } from "react";

export type { Paged } from "@media/ui/lib/pages";

/** Rows a page asks for; the core caps a page to what one call may read. */
const PAGE_ROWS = 100;

/**
 * Follows a paginated core query page by page, each page its own subscription pinned where the
 * next one starts (`@media/ui/lib/pages`). The store is held in state, keyed by the query and its
 * arguments, since React may drop a memo, which would restart every page's subscription.
 *
 * @param argsAt - The query's arguments for a page's `paginationOpts`.
 */
export const usePaged = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
  rows = PAGE_ROWS,
): Paged<Row> => {
  const key = JSON.stringify(argsAt({ numItems: rows, cursor: null }));

  const open = () => pagedStore((span) => query.watch(argsAt({ numItems: rows, ...span })));

  const [held, setHeld] = useState(() => ({ query, key, store: open() }));
  let current = held;

  if (held.query !== query || held.key !== key) {
    current = { query, key, store: open() };
    setHeld(current);
  }

  const { store } = current;

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};

/**
 * Follows every page of a paginated core query, loading the next as soon as one arrives, for
 * lists a screen shows whole: an album's songs, an artist's albums, a playlist's entries.
 */
export const useEveryPage = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
): Paged<Row> => {
  const paged = usePaged(query, argsAt);
  const load = paged.status === "ready" && paged.next.kind === "more" ? paged.next.load : null;

  useEffect(() => {
    load?.();
  }, [load]);

  return paged;
};

/**
 * Every row of a paginated core query once all its pages arrived, else `undefined`, for screens
 * that show a list whole. A failed page throws to the route's error screen, as `useRead` does.
 */
export const useAllRows = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
): ReadonlyArray<Row> | undefined => {
  const paged = useEveryPage(query, argsAt);

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status === "ready" && paged.next.kind === "failed") throw new Error(paged.next.message);

  return paged.status === "ready" && paged.next.kind === "done" ? paged.rows : undefined;
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
