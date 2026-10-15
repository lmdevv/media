import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { scrollRootOf } from "@/lib/scroll-root";

import { useHeld } from "@/lib/use-held";

import { keyOf, usePageChain, useReportPage } from "./page-chain";
import type { PageResult } from "./page-chain";

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
  readonly usePage: (cursor: string | null, end: string | null) => PageResult<Item> | undefined;
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
          end={chain.cursors[index + 1] ?? null}
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
  end,
  last,
  usePage,
  renderItem,
  skeleton,
  onMore,
  onReport,
}: {
  readonly cursor: string | null;
  /** Where the next page starts, once it exists. */
  readonly end: string | null;
  readonly last: boolean;
  readonly usePage: (cursor: string | null, end: string | null) => PageResult<Item> | undefined;
  readonly renderItem: (item: Item) => ReactNode;
  readonly skeleton: ReactNode;
  readonly onMore: (cursor: string) => void;
  readonly onReport: (cursor: string | null, page: PageResult<unknown>) => void;
}) {
  // A page gets `end` once the page after it loads, which re-subscribes it; the previous result
  // stays meanwhile so the list doesn't flash.
  const page = useHeld(usePage(cursor, end));
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
      { root: scrollRootOf(node), rootMargin: "600px" },
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
