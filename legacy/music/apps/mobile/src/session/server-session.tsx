import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { convexLogger } from "@music/sdk/convex-logger";
import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { tokenStorage } from "@/lib/secure-storage";
import type { ServerConnection } from "@/lib/server";

const keepUrl = (): void => undefined;

/** The Convex client and auth for `connection`, provided to everything below. */
export function ServerSession({
  connection,
  children,
}: {
  readonly connection: ServerConnection;
  readonly children: ReactNode;
}) {
  const [client, setClient] = useState<ConvexReactClient | null>(null);

  useEffect(() => {
    const created = new ConvexReactClient(connection.convexUrl, {
      unsavedChangesWarning: false,
      logger: convexLogger(console),
    });

    setClient(created);

    return () => {
      setClient(null);
      setTimeout(() => void created.close(), 0);
    };
  }, [connection.convexUrl]);

  if (client === null) return null;

  return (
    <ConvexAuthProvider
      client={client}
      storage={tokenStorage}
      storageNamespace={connection.origin}
      shouldHandleCode={false}
      replaceURL={keepUrl}
    >
      {children}
    </ConvexAuthProvider>
  );
}
