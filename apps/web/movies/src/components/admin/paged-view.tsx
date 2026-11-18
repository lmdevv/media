import { Button } from "@media/ui/components/button";
import type { Paged } from "@media/ui/lib/pages";
import { Match } from "effect";
import type { ReactNode } from "react";

type Ready<Row> = Extract<Paged<Row>, { readonly status: "ready" }>;

function Failed({ message, retry }: { readonly message: string; readonly retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="font-sans text-body/body text-text-muted">{message}</p>
      <Button variant="raised" size="xs" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/** What follows a paginated list's rows: Show more, a wait, the next page's failure, or nothing. */
export function ShowMore({ next }: { readonly next: Ready<unknown>["next"] }): ReactNode {
  return Match.value(next).pipe(
    Match.discriminatorsExhaustive("kind")({
      done: () => null,
      failed: ({ message, retry }) => <Failed message={message} retry={retry} />,
      loading: () => (
        <div>
          <Button variant="raised" size="xs" disabled>
            Show more
          </Button>
        </div>
      ),
      more: ({ load }) => (
        <div>
          <Button variant="raised" size="xs" onClick={load}>
            Show more
          </Button>
        </div>
      ),
    }),
  );
}

/**
 * Renders a paginated list: `loading` until the first page, its failure as one muted line with Try
 * again, then `children` with every loaded row and what follows them.
 */
export function PagedView<Row>({
  list,
  loading,
  children,
}: {
  readonly list: Paged<Row>;
  readonly loading: ReactNode;
  readonly children: (ready: Ready<Row>) => ReactNode;
}): ReactNode {
  return Match.value(list).pipe(
    Match.discriminatorsExhaustive("status")({
      loading: () => loading,
      failed: ({ message, retry }) => <Failed message={message} retry={retry} />,
      ready: (ready) => children(ready),
    }),
  );
}
