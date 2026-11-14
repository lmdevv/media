import { can, forbiddenMessage } from "@/lib/capabilities";
import type { Capability } from "@/lib/capabilities";
import type { Me } from "@/lib/models";
import type { ReactNode } from "react";

import { useMe } from "./access";
import { SheetLayout } from "@/components/ui/sheet-layout";

export interface SheetAccessProps {
  readonly capability: Capability;
  readonly children: (me: Me) => ReactNode;
}

/** Renders `children` for roles with `capability`, and a refusal sheet for everyone else. */
export function SheetAccess({ capability, children }: SheetAccessProps) {
  const me = useMe();

  if (me === null) return null;

  if (!can(me, capability)) {
    return (
      <SheetLayout
        title={forbiddenMessage(capability)}
        subtitle="Ask the server's owner if you need this."
      />
    );
  }

  return children(me);
}
