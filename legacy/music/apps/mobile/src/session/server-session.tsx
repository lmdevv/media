/**
 * Opens the connected server: one Convex client (and WebSocket) while the app is on it, with
 * Convex Auth keeping its tokens in the keychain under the server's origin.
 */
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { convexLogger } from "@music/sdk/convex-logger";
import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { tokenStorage } from "@/lib/secure-storage";
import type { ServerConnection } from "@/lib/server";

/** The app never reads sign-in codes from a URL, so Convex Auth must not rewrite one. */
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

  // One effect makes and closes the client, so React's development double mount never leaves a
  // closed client in use. React Native has no page to unload, so the unsaved-changes prompt is off.
  // A wrong password is the sign-in screen's to report, not a logged fault (G07).
  useEffect(() => {
    const created = new ConvexReactClient(connection.convexUrl, {
      unsavedChangesWarning: false,
      logger: convexLogger(console),
    });

    setClient(created);

    return () => {
      setClient(null);
      // React runs a removed tree's effect cleanups parent first, and Convex's auth provider
      // below clears the client's auth in its own: closing waits until that has run, or
      // reopening the server (G05's Try again) or leaving it throws on a closed client.
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
