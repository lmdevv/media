import { can, forbiddenMessage } from "@/lib/capabilities";
import type { Capability } from "@/lib/capabilities";
import type { Me } from "@/lib/models";
import { useMaybeMe } from "@/session/me";
import { Lock } from "lucide-react-native";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";

/** The signed-in person, or null while the app shows its downloads without the server. */
export const useMe = (): Me | null => useMaybeMe();

export interface RequireAccessProps {
  readonly capability: Capability;
  /** The page title, kept while the account loads or when access is refused. */
  readonly title: string;
  readonly children: (me: Me) => ReactNode;
}

/** Renders `children` for roles with `capability`, and says why not to everyone else. */
export function RequireAccess({ capability, title, children }: RequireAccessProps) {
  const me = useMe();

  if (me === null)
    return (
      <Page title={title} bottom="plain">
        {null}
      </Page>
    );

  if (!can(me, capability)) {
    return (
      <Page title={title} bottom="plain">
        <EmptyState
          icon={Lock}
          title={forbiddenMessage(capability)}
          body="Ask the server's owner if you need this."
        />
      </Page>
    );
  }

  return children(me);
}
