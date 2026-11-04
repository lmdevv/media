import { MoviesProvider } from "@media/sdk/react";
import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { ServerConnection } from "@/lib/connection";
import { sessionKeyFor, sessionStore } from "@/lib/secure-storage";

/** The SDK and Convex client for `connection`, provided to everything below. */
export function SdkProvider({
  connection,
  children,
}: {
  readonly connection: ServerConnection;
  readonly children: ReactNode;
}) {
  const [client, setClient] = useState<ConvexReactClient | null>(null);

  // One effect makes and closes the client, so React's development double mount never leaves a
  // closed client in use. React Native has no page to unload, so the unsaved-changes prompt is off.
  useEffect(() => {
    const created = new ConvexReactClient(connection.convexUrl, { unsavedChangesWarning: false });

    setClient(created);

    return () => {
      setClient(null);
      void created.close();
    };
  }, [connection.convexUrl]);

  if (client === null) return null;

  return (
    <MoviesProvider
      client={client}
      mediaUrl={connection.mediaUrl}
      storage={sessionStore}
      storageKey={sessionKeyFor(connection.convexUrl)}
    >
      {children}
    </MoviesProvider>
  );
}
