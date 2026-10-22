/**
 * Who is signed in, and a gate for screens only some roles may open. The settings hub hides admin
 * and owner rows from everyone else; this gate covers a deep link or a role that changed while the
 * screen was open. The server still refuses what the role may not do.
 */
import type { User } from "@music/commands/models";
import { can, forbiddenMessage } from "@music/commands/permissions";
import type { Capability } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import { Lock } from "lucide-react-native";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";

/** The signed-in account, or undefined while it loads. */
export const useMe = (): User | undefined => useRead("account.me", {});

/** Props for `RequireAccess`. */
export interface RequireAccessProps {
  readonly capability: Capability;
  /** The page title, kept while the account loads or when access is refused. */
  readonly title: string;
  readonly children: (me: User) => ReactNode;
}

/** Renders `children` for roles with `capability`, and says why not to everyone else. */
export function RequireAccess({ capability, title, children }: RequireAccessProps) {
  const me = useMe();

  if (me === undefined)
    return (
      <Page title={title} bottom="plain">
        {null}
      </Page>
    );

  if (!can(me.role, capability)) {
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
