import type { QueryState } from "@media/sdk/react";
import { useState, useSyncExternalStore } from "react";

import { describeFailure } from "@/lib/failure";

/** Rows asked for per page. */
const PAGE_SIZE = 25;

/** The `paginationOpts` of a paginated core query. */
export interface PageOpts {
  readonly numItems: number;
  readonly cursor: string | null;
}

/** One page of a paginated core query's result. */
export interface PageOf<Row> {
  readonly page: ReadonlyArray<Row>;
  readonly isDone: boolean;
  readonly continueCursor: string;
}

/** A followed query, as a core query's `watch` returns it. */
export interface Watch<A> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => QueryState<A>;
}

/** A paginated core query, such as `platform.core.accounts.users.list`. */
export interface PagedQuery<Args, Row> {
  readonly watch: (args: Args) => Watch<PageOf<Row>>;
}

/** A followed page's state, as a query's watch publishes it. */
export type PageState<Row, Failure> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: PageOf<Row> }
  | { readonly status: "error"; readonly error: Failure; readonly retry: () => void };

/** What follows the rows loaded so far. */
type Next =
  | { readonly kind: "done" }
  | { readonly kind: "more"; readonly load: () => void }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string; readonly retry: () => void };

/** A paginated list as a screen shows it: every loaded page's rows in order, and what follows. */
export type Paged<Row> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string; readonly retry: () => void }
  | { readonly status: "ready"; readonly rows: ReadonlyArray<Row>; readonly next: Next };

/**
 * Folds the states of a list's pages, first to last, into one {@link Paged}. A failed first page
 * fails the list; a later page's failure keeps the rows above it.
 *
 * @param more - Loads the page after the given cursor.
 */
export const combinePages = <Row, Failure>(
  pages: ReadonlyArray<PageState<Row, Failure>>,
  more: (cursor: string) => void,
): Paged<Row> => {
  const rows: Array<Row> = [];

  for (const [index, state] of pages.entries()) {
    if (state.status === "loading") {
      return index === 0
        ? { status: "loading" }
        : { status: "ready", rows, next: { kind: "loading" } };
    }

    if (state.status === "error") {
      const message = describeFailure(state.error);

      return index === 0
        ? { status: "failed", message, retry: state.retry }
        : { status: "ready", rows, next: { kind: "failed", message, retry: state.retry } };
    }

    rows.push(...state.data.page);

    if (index === pages.length - 1) {
      const { isDone, continueCursor } = state.data;

      return {
        status: "ready",
        rows,
        next: isDone ? { kind: "done" } : { kind: "more", load: () => more(continueCursor) },
      };
    }
  }

  return { status: "loading" };
};

interface PagedStore<Row> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => Paged<Row>;
}

/**
 * One store over a list's pages. Load more adds a page to the subscriptions already running, so
 * the pages above keep their subscription and the end Convex pinned for them. Its snapshot stays
 * the same object until a page changes, as `useSyncExternalStore` needs.
 *
 * @param pageAfter - Follows the page that starts at a cursor.
 */
export const pagedStore = <Row>(
  first: Watch<PageOf<Row>>,
  pageAfter: (cursor: string) => Watch<PageOf<Row>>,
): PagedStore<Row> => {
  const watches = [first];
  const asked = new Set<string>();
  const listening = new Map<() => void, Array<() => void>>();
  let inputs: ReadonlyArray<QueryState<PageOf<Row>>> = [];
  let output: Paged<Row> = { status: "loading" };

  const more = (cursor: string): void => {
    if (asked.has(cursor)) return;

    asked.add(cursor);

    const watch = pageAfter(cursor);

    watches.push(watch);

    for (const [onChange, stops] of listening) stops.push(watch.subscribe(onChange));

    for (const onChange of listening.keys()) onChange();
  };

  return {
    subscribe: (onChange) => {
      listening.set(
        onChange,
        watches.map((watch) => watch.subscribe(onChange)),
      );

      return () => {
        for (const stop of listening.get(onChange) ?? []) stop();

        listening.delete(onChange);
      };
    },
    getSnapshot: () => {
      const next = watches.map((watch) => watch.getSnapshot());

      if (next.length !== inputs.length || next.some((state, index) => state !== inputs[index])) {
        inputs = next;
        output = combinePages(next, more);
      }

      return output;
    },
  };
};

/**
 * Follows a paginated core query page by page. Each page is its own subscription from the cursor
 * the page before ended at, so Convex keeps every loaded page's end where it was as rows change.
 *
 * @param argsAt - The query's arguments for a page's `paginationOpts`.
 */
export const usePages = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
): Paged<Row> => {
  const key = JSON.stringify(argsAt({ numItems: PAGE_SIZE, cursor: null }));

  const open = (): PagedStore<Row> =>
    pagedStore(query.watch(argsAt({ numItems: PAGE_SIZE, cursor: null })), (cursor) =>
      query.watch(argsAt({ numItems: PAGE_SIZE, cursor })),
    );

  // State rather than a memo: React may drop a memo, which would restart every page's subscription.
  const [held, setHeld] = useState(() => ({ query, key, store: open() }));
  let current = held;

  if (held.query !== query || held.key !== key) {
    current = { query, key, store: open() };
    setHeld(current);
  }

  const { store } = current;

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};
