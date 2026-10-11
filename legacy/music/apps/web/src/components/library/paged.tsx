import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** One page from a cursor-paginated command. */
export interface PageResult<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly cursor: string;
  readonly done: boolean;
}

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
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);

  return (
    <>
      {cursors.map((cursor, index) => (
        <Page
          key={cursor ?? "first"}
          cursor={cursor}
          first={index === 0}
          last={index === cursors.length - 1}
          usePage={usePage}
          renderItem={renderItem}
          skeleton={skeleton}
          empty={empty}
          onMore={(next) => setCursors((list) => (list.includes(next) ? list : [...list, next]))}
        />
      ))}
    </>
  );
}

function Page<Item>({
  cursor,
  first,
  last,
  usePage,
  renderItem,
  skeleton,
  empty,
  onMore,
}: {
  readonly cursor: string | null;
  readonly first: boolean;
  readonly last: boolean;
  readonly usePage: (cursor: string | null) => PageResult<Item> | undefined;
  readonly renderItem: (item: Item) => ReactNode;
  readonly skeleton: ReactNode;
  readonly empty: ReactNode;
  readonly onMore: (cursor: string) => void;
}) {
  const page = usePage(cursor);
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

  if (first && page.items.length === 0) return <>{empty}</>;

  return (
    <>
      {page.items.map(renderItem)}
      {more === null ? null : <div ref={sentinel} aria-hidden className="col-span-full h-px" />}
    </>
  );
}
