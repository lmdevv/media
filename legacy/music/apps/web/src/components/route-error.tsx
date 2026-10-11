import { Button } from "@music/ui/components/button";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { describeFailure } from "@/lib/action";

/** Shown in place of a screen whose data failed to load. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-start justify-center gap-3 px-6 lg:px-12">
      <h1 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
        This screen didn't load
      </h1>
      <p className="max-w-dialog font-sans text-md/md text-text-muted">{describeFailure(error)}</p>
      <Button variant="solid" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
