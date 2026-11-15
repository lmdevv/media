import type { PlatformSdk } from "@media/sdk/promise";
import type { QueryState } from "@media/sdk/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { QueueEntry, QueueState, Track } from "./playback-controller";
import type { RepeatMode } from "./queue-order";

/*
 * The listener's queue as the music clients follow it: its state from `music.queue.get` and its
 * entries from every page of `music.queue.list`. Each is a subscription of its own, and either can
 * lag the other: a page whose subscription retries keeps its last answer meanwhile, and a client
 * may hear one query's change before the other's. The core answers each with the revision of the
 * queue it read, which moves on with every change to the queue or its entries, so the entries are
 * the queue's whole listing only when every page is in at the revision of the state they go with
 * (ADR 0018). The web player and the phone's both follow the queue through here.
 */

/** Queue entries asked for per page; the core caps a page to what one call may read. */
const QUEUE_PAGE = 200;

/** How long the queue's pages wait before they are followed again after one failed. */
const QUEUE_RESTART_MS = 250;

/** One queue entry as `music.queue.list` answers it. */
export type QueueRow = Awaited<ReturnType<PlatformSdk["music"]["queue"]["list"]>>["page"][number];

/** The queue's state as `music.queue.get` answers it. */
export interface QueueInfo {
  readonly current: string | null;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  readonly autoplay: boolean;
  /** The revision of the queue the core read. */
  readonly revision: number;
}

/** A `music.queue.list` page as the core answers it, with the revision of the queue it read. */
export interface ListingPage<Row> {
  readonly page: ReadonlyArray<Row>;
  readonly isDone: boolean;
  readonly continueCursor: string;
  readonly splitCursor?: string | null;
  readonly pageStatus?: "SplitRecommended" | "SplitRequired" | null;
  readonly revision: number;
}

/** A listing page as the paged store keeps it: one row, which holds the page's rows and revision. */
export interface ListedPage<Row> {
  readonly rows: ReadonlyArray<Row>;
  readonly revision: number;
}

/** The queue's entries as the pages list them. */
export interface QueueListing<Row> {
  readonly rows: ReadonlyArray<Row>;
  /**
   * The revision of the queue the rows list, once every page is in and the core read them all at
   * that one revision; null while the pages load again and `rows` is the last whole listing, or
   * while the pages hold different revisions.
   */
  readonly revision: number | null;
}

/** A followed query, as the SDK's `watch` and the paged store's pages are. */
export interface Watch<A> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => QueryState<A>;
}

/** What follows the pages the paged store folded so far. */
type Next =
  | { readonly kind: "done" }
  | { readonly kind: "more"; readonly load: () => void }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" };

/** The listing's pages as the paged store folds them, first to last. */
type ListedPages<Row> =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | {
      readonly status: "ready";
      readonly rows: ReadonlyArray<ListedPage<Row>>;
      readonly next: Next;
    };

/** Where a page starts, and where it ends once the page after it is loaded. */
interface PageSpan {
  readonly cursor: string | null;
  readonly endCursor?: string;
}

/**
 * The client's paged store: `pagedStore` from `@media/ui/lib/pages` on the web, or from
 * `@media/mobile-core/pages` on iOS, which can't import `@media/ui`.
 */
export type PagedStoreOf = (
  pageAt: (span: PageSpan) => Watch<ListingPage<ListedPage<QueueRow>>>,
) => {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => ListedPages<QueueRow>;
};

/**
 * Follows a listing page as a page of one row, the page itself, so the paged store, which keeps
 * rows alone, keeps each page's revision with its rows. The snapshot stays the same object until
 * the page's does, as the paged store needs.
 */
export const listedPage = <Row>(
  watch: Watch<ListingPage<Row>>,
): Watch<ListingPage<ListedPage<Row>>> => {
  let seen: QueryState<ListingPage<Row>> | null = null;
  let held: QueryState<ListingPage<ListedPage<Row>>> = { status: "loading" };

  return {
    subscribe: watch.subscribe,
    getSnapshot: () => {
      const state = watch.getSnapshot();

      if (state !== seen) {
        seen = state;
        held =
          state.status === "success"
            ? {
                status: "success",
                data: {
                  ...state.data,
                  page: [{ rows: state.data.page, revision: state.data.revision }],
                },
              }
            : state;
      }

      return held;
    },
  };
};

/**
 * The listing `pages` make: their rows in order, and a revision when they are every page
 * (`whole`) and the core read them all at that one revision. Pages read at different revisions
 * make none, since they can leave an entry out, as one that moved from a page not read since to
 * a page read again.
 */
export const listingOf = <Row>(
  pages: ReadonlyArray<ListedPage<Row>>,
  whole: boolean,
): QueueListing<Row> => {
  const [first, ...rest] = pages;

  const revision =
    whole && first !== undefined && rest.every((page) => page.revision === first.revision)
      ? first.revision
      : null;

  return { rows: pages.flatMap((page) => page.rows), revision };
};

/**
 * The queue the player follows: `info`'s state over `listing`'s entries, which are its whole
 * listing (`complete`) only at `info`'s own revision. A whole listing of another revision, as a
 * page whose subscription retries keeps, can lack an entry the queue gained since. A whole listing
 * of the same revision lacks the current entry only when the core leaves it out, as it does an
 * entry whose song the listener may no longer play.
 */
export const queueStateOf = <Row, T extends Track>(
  info: QueueInfo,
  listing: QueueListing<Row>,
  entryOf: (row: Row) => QueueEntry<T>,
): QueueState<T> => ({
  entries: listing.rows.map(entryOf),
  complete: listing.revision === info.revision,
  current: info.current,
  shuffle: info.shuffle,
  repeat: info.repeat,
  autoplay: info.autoplay,
});

const queuePages = (platform: PlatformSdk, pagedStore: PagedStoreOf) =>
  pagedStore((span) =>
    listedPage(
      platform.music.queue.list.watch({ paginationOpts: { numItems: QUEUE_PAGE, ...span } }),
    ),
  );

/**
 * Every entry of the listener's queue, followed live, loading the next page as soon as one
 * arrives; null until every page first arrived. A new queue (`music.queue.play`) lists another
 * generation's entries, so Convex refuses the cursors its pages were following (`InvalidCursor`,
 * which the SDK reports as a protocol error); the pages then start over from the top, as Convex's
 * own paginated hook does. The last whole listing stays while the pages load again, as when the
 * queue grows past a page or starts over, so the player never drops the song it shows; it has no
 * revision meanwhile, so Connect waits for the pages before it tells a move from a new song.
 *
 * @param pagedStore - The client's paged store.
 */
export const useQueueListing = (
  platform: PlatformSdk,
  pagedStore: PagedStoreOf,
): QueueListing<QueueRow> | null => {
  const [store, setStore] = useState(() => queuePages(platform, pagedStore));
  const [last, setLast] = useState<ReadonlyArray<ListedPage<QueueRow>> | null>(null);
  const paged = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const load = paged.status === "ready" && paged.next.kind === "more" ? paged.next.load : null;
  const whole = paged.status === "ready" && paged.next.kind === "done" ? paged.rows : null;

  if (whole !== null && whole !== last) setLast(whole);

  const failed =
    paged.status === "failed" || (paged.status === "ready" && paged.next.kind === "failed");

  useEffect(() => {
    load?.();
  }, [load]);

  useEffect(() => {
    if (!failed) return undefined;

    const timer = setTimeout(() => {
      setStore(queuePages(platform, pagedStore));
    }, QUEUE_RESTART_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [failed, platform, pagedStore]);

  const pages = whole ?? last;
  const isWhole = whole !== null;

  return useMemo(() => (pages === null ? null : listingOf(pages, isWhole)), [pages, isWhole]);
};
