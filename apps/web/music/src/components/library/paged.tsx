import { Button } from "@/components/ui/button";
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import type { Paged as PagedRows } from "@media/ui/lib/pages";
import { scrollRootOf } from "@/lib/scroll-root";
import { cn } from "@/lib/utils";

/** Where to place a list's sentinel, and whether there is a next page for it to load. */
interface MoreOnView {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly more: boolean;
}

/**
 * The sentinel to place after a paginated list's rows: when it scrolls near view, the list loads
 * its next page.
 */
const useMoreOnView = <Row,>(paged: PagedRows<Row>): MoreOnView => {
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
 * Shown after the rows a list already has when its next page failed to load, so a list never
 * stops short in silence: what went wrong, and a way to load that page again.
 */
export function MoreFailed({
  message,
  retry,
  className,
}: {
  readonly message: string;
  readonly retry: () => void;
  readonly className?: string;
}) {
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-3 py-6", className)}>
      <p className="max-w-dialog font-sans text-md/md text-text-muted">
        The rest of this list didn&apos;t load. {message}
      </p>
      <Button variant="secondary" size="sm" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * What follows a paginated list's rows: a skeleton while the next page loads, the sentinel that
 * loads it once the end scrolls near view, or the failure of that page with a retry.
 */
export function ListTail({
  paged,
  skeleton,
}: {
  readonly paged: Extract<PagedRows<unknown>, { readonly status: "ready" }>;
  readonly skeleton: ReactNode;
}) {
  const sentinel = useMoreOnView(paged);
  const { next } = paged;

  return (
    <>
      {next.kind === "loading" ? skeleton : null}
      {next.kind === "failed" ? (
        <MoreFailed message={next.message} retry={next.retry} className="col-span-full" />
      ) : null}
      {sentinel.more ? <div ref={sentinel.ref} aria-hidden className="col-span-full h-px" /> : null}
    </>
  );
}

/**
 * Renders a paginated list as live pages: the rows of every page loaded so far, and the next page
 * once the end of the list scrolls into view. Rows render inside the caller's container, so a grid
 * flows across page boundaries. A failed next page shows under the rows with a retry.
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
  if (paged.status === "loading") return <>{skeleton}</>;

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.rows.length === 0 && paged.next.kind === "done") return <>{empty ?? null}</>;

  return (
    <>
      {paged.rows.map(renderItem)}
      <ListTail paged={paged} skeleton={skeleton} />
    </>
  );
}
