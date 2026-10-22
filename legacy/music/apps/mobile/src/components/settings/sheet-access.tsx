/**
 * `RequireAccess` for confirmation sheets: the sheet stays empty while the account loads and says
 * why not to a role without the capability, in the sheet's own layout rather than a page.
 */
import type { User } from "@music/commands/models";
import { can, forbiddenMessage } from "@music/commands/permissions";
import type { Capability } from "@music/commands/permissions";
import type { ReactNode } from "react";

import { useMe } from "./access";
import { SheetLayout } from "@/components/ui/sheet-layout";

/** Props for `SheetAccess`. */
export interface SheetAccessProps {
  readonly capability: Capability;
  readonly children: (me: User) => ReactNode;
}

/** Renders `children` for roles with `capability`, and a refusal sheet for everyone else. */
export function SheetAccess({ capability, children }: SheetAccessProps) {
  const me = useMe();

  if (me === undefined) return null;

  if (!can(me.role, capability)) {
    return (
      <SheetLayout
        title={forbiddenMessage(capability)}
        subtitle="Ask the server's owner if you need this."
      />
    );
  }

  return children(me);
}
