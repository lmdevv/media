import type { QueryState } from "@media/sdk/react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { describeFailure } from "@media/ui/lib/failure";

/** Rows asked for per page. */
const PAGE_SIZE = 25;

/** The `paginationOpts` of a paginated core query. */
export interface PageOpts {
  readonly numItems: number;
  readonly cursor: string | null;
  /** Where the page ends, once a later page starts there; Convex then keeps that boundary. */
  readonly endCursor?: string;
}

/** Where a page starts, and where it ends once the page after it is loaded. */
export interface PageSpan {
  readonly cursor: string | null;
  readonly endCursor?: string;
}

/** One page of a paginated core query's result. */
export interface PageOf<Row> {
  readonly page: ReadonlyArray<Row>;
  readonly isDone: boolean;
  readonly continueCursor: string;
  /** Where to split a page pinned to an end that grew past what one call may read. */
  readonly splitCursor?: string | null;
  /** `SplitRequired` asks the client to load the page as two, at `splitCursor`. */
  readonly pageStatus?: "SplitRecommended" | "SplitRequired" | null;
}

/** Whether a page must be loaded again as two pages before its rows can be shown. */
const mustSplit = <Row>(
  data: PageOf<Row>,
): data is PageOf<Row> & { readonly splitCursor: string } =>
  data.pageStatus === "SplitRequired" &&
  data.splitCursor !== null &&
  data.splitCursor !== undefined;

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
 * fails the list; a later page's failure keeps the rows above it. A page waiting to be split, or a
 * last page that holds no rows but is not the end, counts as loading: the store loads what follows.
 *
 * @param more - Loads the page after the given cursor.
 */
export const combinePages = <Row, Failure>(
  pages: ReadonlyArray<PageState<Row, Failure>>,
  more: (cursor: string) => void,
): Paged<Row> => {
  const rows: Array<Row> = [];

  for (const [index, state] of pages.entries()) {
    if (state.status === "loading" || (state.status === "success" && mustSplit(state.data))) {
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
      const { isDone, continueCursor, page } = state.data;

      if (isDone) return { status: "ready", rows, next: { kind: "done" } };

      return page.length === 0
        ? { status: "ready", rows, next: { kind: "loading" } }
        : { status: "ready", rows, next: { kind: "more", load: () => more(continueCursor) } };
    }
  }

  return { status: "loading" };
};

interface PagedStore<Row> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => Paged<Row>;
}

/** A loaded page: its subscription, and while a pinned one starts, the open-ended one before it. */
interface Loaded<Row> {
  readonly watch: Watch<PageOf<Row>>;
  readonly before: Watch<PageOf<Row>> | null;
}

/**
 * One store over a list's pages. Loading the next page pins the page above to end where the next
 * one starts, so a row that moves into or out of the pages above never shows twice or goes
 * missing. The open-ended subscription keeps serving the page until the pinned one answers, then
 * stops. A pinned page that grew past what one call may read comes back `SplitRequired`, and the
 * store loads it again as two pages at its `splitCursor`. A last page that holds no rows (every
 * row in its range hidden from this person) but is not the end loads the next page by itself, so
 * a screen never shows an empty list that is not done. Its snapshot stays the same object until a
 * page changes, as `useSyncExternalStore` needs.
 *
 * @param pageAt - Follows the page that starts at a cursor, ended at `endCursor` when given.
 */
export const pagedStore = <Row>(
  pageAt: (span: PageSpan) => Watch<PageOf<Row>>,
): PagedStore<Row> => {
  const pages: Array<Loaded<Row>> = [{ watch: pageAt({ cursor: null }), before: null }];
  const starts: Array<string | null> = [null];
  const listening = new Map<() => void, Map<Watch<PageOf<Row>>, () => void>>();
  let inputs: ReadonlyArray<QueryState<PageOf<Row>>> = [];
  let output: Paged<Row> = { status: "loading" };

  const stopReplacedWatches = (): void => {
    for (const [index, loaded] of pages.entries()) {
      const { before } = loaded;

      if (before !== null && loaded.watch.getSnapshot().status !== "loading") {
        pages[index] = { watch: loaded.watch, before: null };

        for (const stops of listening.values()) {
          stops.get(before)?.();
          stops.delete(before);
        }
      }
    }
  };

  const listen = (watch: Watch<PageOf<Row>>): void => {
    for (const [onChange, stops] of listening) stops.set(watch, follow(watch, onChange));
  };

  const unlisten = (watch: Watch<PageOf<Row>>): void => {
    for (const stops of listening.values()) {
      stops.get(watch)?.();
      stops.delete(watch);
    }
  };

  /** Loads each pinned page the server asked to split as the two pages either side of the split. */
  const splitPages = (): void => {
    for (const [index, loaded] of pages.entries()) {
      const state = loaded.watch.getSnapshot();
      const start = starts[index];
      const end = starts[index + 1];

      if (
        state.status === "success" &&
        mustSplit(state.data) &&
        start !== undefined &&
        end !== undefined &&
        end !== null
      ) {
        const split = state.data.splitCursor;
        const lower = pageAt({ cursor: start, endCursor: split });
        const upper = pageAt({ cursor: split, endCursor: end });

        pages.splice(index, 1, { watch: lower, before: null }, { watch: upper, before: null });
        starts.splice(index + 1, 0, split);
        unlisten(loaded.watch);

        if (loaded.before !== null) unlisten(loaded.before);
        listen(lower);
        listen(upper);
        splitPages();

        return;
      }
    }
  };

  /** Loads the next page when the last one holds no rows but is not the end. */
  const followEmptyTail = (): void => {
    const last = pages.at(-1);
    const state = last?.watch.getSnapshot();

    if (
      state?.status === "success" &&
      !state.data.isDone &&
      state.data.page.length === 0 &&
      !mustSplit(state.data)
    ) {
      more(state.data.continueCursor);
    }
  };

  const settle = (): void => {
    stopReplacedWatches();
    splitPages();
    followEmptyTail();
  };

  function follow(watch: Watch<PageOf<Row>>, onChange: () => void): () => void {
    return watch.subscribe(() => {
      settle();
      onChange();
    });
  }

  const stateOf = (loaded: Loaded<Row>): QueryState<PageOf<Row>> => {
    const state = loaded.watch.getSnapshot();

    return state.status === "loading" && loaded.before !== null
      ? loaded.before.getSnapshot()
      : state;
  };

  const more = (cursor: string): void => {
    if (starts.includes(cursor)) return;

    const last = pages.length - 1;
    const above = pages[last];
    const start = starts[last];

    if (above !== undefined && start !== undefined) {
      const pinned = pageAt({ cursor: start, endCursor: cursor });

      pages[last] = { watch: pinned, before: above.watch };
      listen(pinned);
    }

    const next = pageAt({ cursor });

    pages.push({ watch: next, before: null });
    starts.push(cursor);
    listen(next);
    settle();

    for (const onChange of listening.keys()) onChange();
  };

  const watches = (): ReadonlyArray<Watch<PageOf<Row>>> =>
    pages.flatMap((loaded) =>
      loaded.before === null ? [loaded.watch] : [loaded.watch, loaded.before],
    );

  return {
    subscribe: (onChange) => {
      listening.set(onChange, new Map(watches().map((watch) => [watch, follow(watch, onChange)])));
      settle();

      return () => {
        for (const stop of listening.get(onChange)?.values() ?? []) stop();

        listening.delete(onChange);
      };
    },
    getSnapshot: () => {
      const next = pages.map(stateOf);

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
 * the page before ended at, pinned to end where the page after it starts.
 *
 * @param argsAt - The query's arguments for a page's `paginationOpts`.
 */
export const usePages = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
): Paged<Row> => {
  const key = JSON.stringify(argsAt({ numItems: PAGE_SIZE, cursor: null }));

  const open = (): PagedStore<Row> =>
    pagedStore((span) => query.watch(argsAt({ numItems: PAGE_SIZE, ...span })));

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

/**
 * Follows every page of a paginated core query, loading the next page as soon as one arrives. For
 * lists a picker must offer whole, such as the people and groups to share with, which stay small
 * in a household.
 */
export const useAllPages = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
): Paged<Row> => {
  const paged = usePages(query, argsAt);
  const load = paged.status === "ready" && paged.next.kind === "more" ? paged.next.load : null;

  useEffect(() => {
    load?.();
  }, [load]);

  return paged;
};

/**
 * Follows a paginated core query until it holds `count` rows or ends, for a row that shows the
 * first few. A core page can hold fewer rows than asked, even none, when the caller may not see
 * the rows its range covers, so the first page alone can leave such a row empty.
 */
export const useFirstRows = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
  count: number,
): Paged<Row> => {
  const paged = usePages(query, argsAt);

  const load =
    paged.status === "ready" && paged.rows.length < count && paged.next.kind === "more"
      ? paged.next.load
      : null;

  useEffect(() => {
    load?.();
  }, [load]);

  return paged;
};
