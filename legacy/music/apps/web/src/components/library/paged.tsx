import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** One page from a cursor-paginated command. */
export interface PageResult<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly cursor: string;
  readonly done: boolean;
}

/** What a loaded page reported: how many items it shows and whether it is the last. */
interface PageReport {
  readonly items: number;
  readonly done: boolean;
}

const keyOf = (cursor: string | null): string => cursor ?? "first";

/**
 * What a chain of pages shows, from each page's report in order (undefined while it loads): the
 * list is empty when every page is empty and the last is done, and the first page with items
 * carries a list header.
 */
export const summarizeChain = (reported: ReadonlyArray<PageReport | undefined>) => ({
  empty: reported.every((page) => page?.items === 0) && reported.at(-1)?.done === true,
  firstFilled: reported.findIndex((page) => (page?.items ?? 0) > 0),
});

/**
 * The cursors of a list loaded page by page, and what each page reported. A page can be empty
 * while more follow (its rows were in libraries you can't read), so emptiness is a property of the
 * whole chain: every page loaded so far is empty and the last one is done.
 */
export const usePageChain = () => {
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);
  const [reports, setReports] = useState<ReadonlyMap<string, PageReport>>(new Map());

  const more = useCallback((next: string) => {
    setCursors((list) => (list.includes(next) ? list : [...list, next]));
  }, []);

  const report = useCallback((cursor: string | null, items: number, done: boolean) => {
    setReports((current) => {
      const previous = current.get(keyOf(cursor));

      if (previous?.items === items && previous.done === done) return current;

      return new Map(current).set(keyOf(cursor), { items, done });
    });
  }, []);

  return {
    cursors,
    more,
    report,
    ...summarizeChain(cursors.map((cursor) => reports.get(keyOf(cursor)))),
  };
};

/** Tells the chain what `page` shows once it loads or changes. */
export const useReportPage = (
  cursor: string | null,
  page: PageResult<unknown> | undefined,
  report: (cursor: string | null, items: number, done: boolean) => void,
): void => {
  const items = page?.items.length;
  const done = page?.done;

  useEffect(() => {
    if (items !== undefined && done !== undefined) report(cursor, items, done);
  }, [cursor, items, done, report]);
};

/**
 * Renders a cursor-paginated list as live pages: each page keeps its own subscription, and the
 * next page loads when the end of the list scrolls into view. Pages render inside the caller's
 * container, so a grid flows across page boundaries.
 */
export function Paged<Item>({
  usePage,
  renderItem,
  skeleton,
  empty,
}: {
  readonly usePage: (cursor: string | null) => PageResult<Item> | undefined;
  readonly renderItem: (item: Item) => ReactNode;
  readonly skeleton: ReactNode;
  readonly empty?: ReactNode;
}) {
  const chain = usePageChain();

  return (
    <>
      {chain.cursors.map((cursor, index) => (
        <Page
          key={keyOf(cursor)}
          cursor={cursor}
          last={index === chain.cursors.length - 1}
          usePage={usePage}
          renderItem={renderItem}
          skeleton={skeleton}
          onMore={chain.more}
          onReport={chain.report}
        />
      ))}
      {chain.empty ? empty : null}
    </>
  );
}

function Page<Item>({
  cursor,
  last,
  usePage,
  renderItem,
  skeleton,
  onMore,
  onReport,
}: {
  readonly cursor: string | null;
  readonly last: boolean;
  readonly usePage: (cursor: string | null) => PageResult<Item> | undefined;
  readonly renderItem: (item: Item) => ReactNode;
  readonly skeleton: ReactNode;
  readonly onMore: (cursor: string) => void;
  readonly onReport: (cursor: string | null, items: number, done: boolean) => void;
}) {
  const page = usePage(cursor);
  useReportPage(cursor, page, onReport);
  const sentinel = useRef<HTMLDivElement>(null);
  const more = page !== undefined && !page.done && last ? page.cursor : null;

  useEffect(() => {
    const node = sentinel.current;

    if (more === null || node === null) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMore(more);
      },
      { rootMargin: "600px" },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [more, onMore]);

  if (page === undefined) return <>{skeleton}</>;

  // An empty page renders only its sentinel, which stays in view and loads the next one.
  return (
    <>
      {page.items.map(renderItem)}
      {more === null ? null : <div ref={sentinel} aria-hidden className="col-span-full h-px" />}
    </>
  );
}
