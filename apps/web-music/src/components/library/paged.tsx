import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import type { Paged as PagedRows } from "@media/ui/lib/pages";
import { scrollRootOf } from "@/lib/scroll-root";

/** Where to place a list's sentinel, and whether there is a next page for it to load. */
interface MoreOnView {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly more: boolean;
}

/**
 * The sentinel to place after a paginated list's rows: when it scrolls near view, the list loads
 * its next page.
 */
export const useMoreOnView = <Row,>(paged: PagedRows<Row>): MoreOnView => {
  const ref = useRef<HTMLDivElement>(null);
  const more = paged.status === "ready" && paged.next.kind === "more" ? paged.next.load : null;

  useEffect(() => {
    const node = ref.current;

    if (more === null || node === null) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more();
      },
      { root: scrollRootOf(node), rootMargin: "600px" },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [more]);

  return { ref, more: more !== null };
};

/**
 * Renders a paginated list as live pages: the rows of every page loaded so far, and the next page
 * once the end of the list scrolls into view. Rows render inside the caller's container, so a grid
 * flows across page boundaries.
 */
export function Paged<Row>({
  paged,
  renderItem,
  skeleton,
  empty,
}: {
  readonly paged: PagedRows<Row>;
  readonly renderItem: (row: Row) => ReactNode;
  readonly skeleton: ReactNode;
  readonly empty?: ReactNode;
}) {
  const sentinel = useMoreOnView(paged);

  if (paged.status === "loading") return <>{skeleton}</>;

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.rows.length === 0 && paged.next.kind === "done") return <>{empty ?? null}</>;

  return (
    <>
      {paged.rows.map(renderItem)}
      {paged.next.kind === "loading" ? skeleton : null}
      {sentinel.more ? <div ref={sentinel.ref} aria-hidden className="col-span-full h-px" /> : null}
    </>
  );
}
