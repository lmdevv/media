import {
  readConnection,
  readPhoneAccount,
  sessionKeyFor,
  writeConnection,
} from "@media/mobile-core/records";
import { discoverServer } from "@media/mobile-core/server";
import type { ServerConnection } from "@media/mobile-core/server";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { appKeychains } from "@/lib/keychains";

/** The connection and the ways to change it. */
export interface ConnectionState {
  /** Where the app connects, or null before anyone connected this install. */
  readonly connection: ServerConnection | null;
  /**
   * True while the app connects, on its first launch, to the server another [media] app on the
   * phone signed in to, as the shared keychain names it (D48).
   */
  readonly joining: boolean;
  /** Remembers a server and opens the app on it. */
  readonly connect: (connection: ServerConnection) => void;
  /** Forgets the server and this app's session on it, back to the welcome screen. */
  readonly disconnect: () => void;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

/**
 * Holds the connection, starting from the one this install remembers. An install that remembers
 * none joins the server the phone's shared keychain names, if another app signed in there.
 */
export function ConnectionProvider({ children }: { readonly children: ReactNode }) {
  const [connection, setConnection] = useState<ServerConnection | null>(() =>
    readConnection(appKeychains().own),
  );

  const [joining, setJoining] = useState(
    () => connection === null && readPhoneAccount(appKeychains().shared) !== null,
  );

  const connect = useCallback((next: ServerConnection) => {
    writeConnection(appKeychains().own, next);
    setConnection(next);
  }, []);

  useEffect(() => {
    if (!joining) return undefined;

    const account = readPhoneAccount(appKeychains().shared);

    if (account === null) {
      setJoining(false);

      return undefined;
    }

    const stop = new AbortController();

    const join = async () => {
      const result = await discoverServer(account.server);

      if (stop.signal.aborted) return;

      if (result.ok) connect(result.connection);

      setJoining(false);
    };

    void join();

    return () => stop.abort();
  }, [joining, connect]);

  const disconnect = useCallback(() => {
    writeConnection(appKeychains().own, null);

    if (connection !== null) appKeychains().own.write(sessionKeyFor(connection.mediaUrl), null);

    setConnection(null);
  }, [connection]);

  const value = useMemo(
    () => ({ connection, joining, connect, disconnect }),
    [connection, joining, connect, disconnect],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/**
 * The app's server connection.
 *
 * @throws When used outside `ConnectionProvider`, a programming error.
 */
export const useConnection = (): ConnectionState => {
  const state = useContext(ConnectionContext);

  if (state === null) throw new Error("useConnection must be used inside ConnectionProvider");

  return state;
};

/**
 * The connected server. Use only below the connected part of the app.
 *
 * @throws When no server is connected, a programming error.
 */
export const useServer = (): ServerConnection => {
  const { connection } = useConnection();

  if (connection === null) throw new Error("useServer must be used once a server is connected");

  return connection;
};
