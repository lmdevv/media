import type { Scope } from "@media/contracts/scopes";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { Spinner } from "@media/ui/components/spinner";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useViewer } from "@/session/viewer";

/**
 * Renders `children` only for sessions that hold one of `scopes`. Others see a calm “not for this
 * account” state; the server refuses their calls anyway, so this only spares them broken screens.
 */
export function ScopeGate({
  scopes,
  children,
}: {
  readonly scopes: ReadonlyArray<Scope>;
  readonly children: ReactNode;
}) {
  const viewer = useViewer();

  if (viewer === null) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="size-8 text-text" label="Loading" />
      </div>
    );
  }

  if (scopes.some((scope) => viewer.scopes.includes(scope))) {
    return children;
  }

  return (
    <CalmState
      className="py-24"
      title="Only admins can open this"
      actions={
        <Link to="/" className={buttonVariants({ variant: "raised", size: "sm" })}>
          Go to Home
        </Link>
      }
    />
  );
}
