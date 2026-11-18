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

/** The phases that offer Try again: the server never answered this launch. */
export type RetriedPhase = "unreachable" | "offline";

/** The connection and the ways to change it. */
export interface ConnectionControls {
  /** Where the app connects, or null before anyone connected this install. */
  readonly connection: ServerConnection | null;
  /**
   * True while the app connects, on its first launch, to the server another Lar app on the
   * phone signed in to, as the shared keychain names it (D48).
   */
  readonly joining: boolean;
  /** Remembers a server and opens the app on it. */
  readonly connect: (connection: ServerConnection) => void;
  /** Forgets the server and this app's session on it, back to Welcome. */
  readonly disconnect: () => void;
  /**
   * Opens the server again from scratch, as Try again does when it never answered: from the
   * unreachable screen, or from the downloads (`offline`), which stay on show while it waits.
   */
  readonly reconnect: (from: RetriedPhase) => void;
  /**
   * Bumped by `reconnect`, and back to 0 on another connection; the platform client is keyed by
   * it, so a new client replaces the old.
   */
  readonly attempt: number;
  /** The phase on show when `reconnect` last ran. */
  readonly retriedFrom: RetriedPhase;
}

const ConnectionContext = createContext<ConnectionControls | null>(null);

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

  const [attempt, setAttempt] = useState(0);
  const [retriedFrom, setRetriedFrom] = useState<RetriedPhase>("unreachable");

  const connect = useCallback((next: ServerConnection) => {
    writeConnection(appKeychains().own, next);
    setConnection(next);
    setAttempt(0);
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
    setAttempt(0);
  }, [connection]);

  const reconnect = useCallback((from: RetriedPhase) => {
    setRetriedFrom(from);
    setAttempt((count) => count + 1);
  }, []);

  const value = useMemo(
    () => ({ connection, joining, connect, disconnect, reconnect, attempt, retriedFrom }),
    [connection, joining, connect, disconnect, reconnect, attempt, retriedFrom],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/**
 * The connection and the ways to change it, for screens that work with or without a server.
 *
 * @throws When used outside `ConnectionProvider`, a programming error.
 */
export const useConnectionControls = (): ConnectionControls => {
  const controls = useContext(ConnectionContext);

  if (controls === null) throw new Error("useConnectionControls needs ConnectionProvider above it");

  return controls;
};

export interface Connection extends ServerConnection {
  readonly connect: (connection: ServerConnection) => void;
  readonly disconnect: () => void;
  readonly reconnect: (from: RetriedPhase) => void;
}

/**
 * The connected server. Use it below the connected part of the app, where a server is known.
 *
 * @throws When no server is connected, a programming error.
 */
export const useConnection = (): Connection => {
  const { connection, connect, disconnect, reconnect } = useConnectionControls();

  if (connection === null) throw new Error("useConnection needs a connected server");

  return { ...connection, connect, disconnect, reconnect };
};

/**
 * The connected server's addresses. Use only below the connected part of the app.
 *
 * @throws When no server is connected, a programming error.
 */
export const useServer = (): ServerConnection => {
  const { connection } = useConnectionControls();

  if (connection === null) throw new Error("useServer must be used once a server is connected");

  return connection;
};
