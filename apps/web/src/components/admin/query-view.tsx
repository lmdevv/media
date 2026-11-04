import type { QueryState } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Match } from "effect";
import type { ReactNode } from "react";

import { describeFailure } from "@/lib/failure";

/**
 * Renders a live query: `loading` until the first result, its failure as one muted line with Try
 * again, then `children` with the data on every update.
 */
export function QueryView<A>({
  query,
  loading,
  children,
}: {
  readonly query: QueryState<A>;
  readonly loading: ReactNode;
  readonly children: (data: A) => ReactNode;
}): ReactNode {
  return Match.value(query).pipe(
    Match.discriminatorsExhaustive("status")({
      loading: () => loading,
      error: ({ error, retry }) => (
        <div className="flex flex-col items-start gap-3">
          <p className="font-sans text-body/body text-text-muted">{describeFailure(error)}</p>
          <Button variant="raised" size="xs" onClick={retry}>
            Try again
          </Button>
        </div>
      ),
      success: ({ data }) => children(data),
    }),
  );
}
