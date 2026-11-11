import { MoviesProvider } from "@media/sdk/react";
import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { useServer } from "./connection";

/** No session: the old movies SDK only reaches the owner screens' functions, which hold none. */
const noSession = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/**
 * The old movies SDK, for the owner screens only, until `p4-mobile-owner` moves them onto the core
 * (D56). The core runs none of old movies' functions, so against an install these screens show
 * their load failure.
 */
export function LegacyMoviesProvider({ children }: { readonly children: ReactNode }) {
  const { convexUrl, mediaUrl } = useServer();
  const [client, setClient] = useState<ConvexReactClient | null>(null);

  useEffect(() => {
    const created = new ConvexReactClient(convexUrl, { unsavedChangesWarning: false });

    setClient(created);

    return () => {
      setClient(null);
      void created.close();
    };
  }, [convexUrl]);

  if (client === null) return null;

  return (
    <MoviesProvider client={client} mediaUrl={mediaUrl} storage={noSession}>
      {children}
    </MoviesProvider>
  );
}
