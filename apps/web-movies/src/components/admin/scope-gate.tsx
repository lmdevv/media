import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { Spinner } from "@media/ui/components/spinner";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useMe } from "@/session/session";
import type { Me } from "@/session/session";

/**
 * Who may open an admin screen: `edit` needs the session's `movies:edit` scope, as fixing a match
 * or scanning does; `admin` needs an owner or admin holding the `admin` scope, as the server's
 * importer routes do.
 */
export type Access = "edit" | "admin";

/** Whether `me` may open a screen that needs `access`. */
export const allows = (me: Me, access: Access): boolean =>
  access === "edit"
    ? me.scopes.includes("movies:edit")
    : (me.role === "owner" || me.role === "admin") && me.scopes.includes("admin");

/**
 * Renders `children` only for sessions that {@link allows} `access`. Others see a calm “not for
 * this account” state; the server refuses their calls anyway, so this only spares them broken
 * screens.
 */
export function ScopeGate({
  access,
  children,
}: {
  readonly access: Access;
  readonly children: ReactNode;
}) {
  const me = useMe();

  if (me === null) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="size-8 text-text" label="Loading" />
      </div>
    );
  }

  if (allows(me, access)) return children;

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
