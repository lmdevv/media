import type { ProfileId } from "@media/contracts/ids";
import type { TitleCard, TitleKind } from "@media/contracts/models/catalog";
import { useCommandQuery } from "@media/sdk/react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { listArgs } from "@/lib/browse";
import type { BrowseFilters } from "@/lib/browse";

const PAGE_SIZE = 60;

interface LoadedPage {
  readonly items: ReadonlyArray<TitleCard>;
  readonly nextCursor: string | null;
}

function PageSubscription({
  query,
  profileId,
  kind,
  filters,
  cursor,
  index,
  onPage,
  onError,
}: {
  readonly query: string;
  readonly profileId: ProfileId;
  readonly kind: TitleKind | null;
  readonly filters: BrowseFilters;
  readonly cursor: string | null;
  readonly index: number;
  readonly onPage: (query: string, index: number, page: LoadedPage) => void;
  readonly onError: (query: string, cause: unknown) => void;
}) {
  const page = useCommandQuery(
    "titles.list",
    listArgs(profileId, kind, filters, cursor, PAGE_SIZE),
  );

  useEffect(() => {
    if (page.status === "success") onPage(query, index, page.data);
    else if (page.status === "error") onError(query, page.error);
  }, [page, query, index, onPage, onError]);

  return null;
}

/** The loaded titles of a paged list and the ways to move it along. */
export interface TitlePages {
  /** Render this somewhere in the screen; it holds the page subscriptions. */
  readonly subscriptions: ReactNode;
  readonly titles: ReadonlyArray<TitleCard>;
  /** The first page has arrived. */
  readonly loaded: boolean;
  /** The last page has arrived. */
  readonly complete: boolean;
  /** Why a page failed, if one did. */
  readonly failure: { readonly cause: unknown } | null;
  /** Asks for the page after the last one loaded. */
  readonly loadMore: () => void;
  /** Subscribes to every page again after a failure. */
  readonly retry: () => void;
}

interface Paging {
  readonly query: string;
  readonly pages: ReadonlyArray<LoadedPage | undefined>;
  readonly cursors: ReadonlyArray<string | null>;
  readonly failure: { readonly cause: unknown } | null;
  readonly attempt: number;
}

const startPaging = (query: string): Paging => ({
  query,
  pages: [],
  cursors: [null],
  failure: null,
  attempt: 0,
});

/**
 * Pages of `titles.list` for the profile, kind, and filters. Changing any of them starts over from
 * the first page, and answers that arrive for the old query are dropped.
 */
export const useTitlePages = (
  profileId: ProfileId,
  kind: TitleKind | null,
  filters: BrowseFilters,
): TitlePages => {
  const query = JSON.stringify([profileId, kind, filters.sort, filters.genre, filters.libraryId]);
  const [held, setHeld] = useState(() => startPaging(query));
  let paging = held;

  if (held.query !== query) {
    paging = startPaging(query);
    setHeld(paging);
  }

  const { pages, cursors, failure, attempt } = paging;
  const last = pages[cursors.length - 1];

  const onPage = useCallback((pageQuery: string, index: number, page: LoadedPage) => {
    setHeld((current) => {
      if (current.query !== pageQuery) return current;

      const next = [...current.pages];

      next[index] = page;

      return { ...current, pages: next };
    });
  }, []);

  const onError = useCallback((pageQuery: string, cause: unknown) => {
    setHeld((current) =>
      current.query !== pageQuery || current.failure !== null
        ? current
        : { ...current, failure: { cause } },
    );
  }, []);

  const loadMore = useCallback(() => {
    const cursor = last?.nextCursor;

    if (cursor === undefined || cursor === null || failure !== null) return;

    setHeld((current) =>
      current.query !== query || current.cursors.includes(cursor)
        ? current
        : { ...current, cursors: [...current.cursors, cursor] },
    );
  }, [last, failure, query]);

  const retry = useCallback(() => {
    setHeld((current) =>
      current.query === query
        ? { ...current, failure: null, attempt: current.attempt + 1 }
        : current,
    );
  }, [query]);

  const subscriptions = cursors.map((cursor, index) => (
    <PageSubscription
      key={`${query}:${cursor ?? "first"}:${attempt}`}
      query={query}
      profileId={profileId}
      kind={kind}
      filters={filters}
      cursor={cursor}
      index={index}
      onPage={onPage}
      onError={onError}
    />
  ));

  return {
    subscriptions,
    titles: pages.flatMap((page) => page?.items ?? []),
    loaded: pages[0] !== undefined,
    complete: last !== undefined && last.nextCursor === null,
    failure,
    loadMore,
    retry,
  };
};
