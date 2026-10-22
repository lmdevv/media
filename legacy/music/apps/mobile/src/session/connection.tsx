/**
 * The server connection for the whole app. Screens before connecting read and change it with
 * `useConnectionControls`; once connected, everything below reads the server with
 * `useConnection`.
 */
import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import { loadConnection, saveConnection } from "@/lib/connection-store";
import type { ServerConnection } from "@/lib/server";

/** The connection and the ways to change it. */
export interface ConnectionControls {
  /** Where the app connects, or null before anyone connected this install. */
  readonly connection: ServerConnection | null;
  /** Remembers a server and opens the app on it. */
  readonly connect: (connection: ServerConnection) => void;
  /**
   * Forgets the server, back to Welcome. Its tokens stay in the keychain under its origin, so
   * connecting to it again finds the session it had.
   */
  readonly disconnect: () => void;
  /** Opens the server again from scratch, as Try again does when it never answered (G05). */
  readonly reconnect: () => void;
  /**
   * Bumped by `reconnect`, and back to 0 on another connection; the server session is keyed by it,
   * so a new client replaces the old.
   */
  readonly attempt: number;
}

const ConnectionContext = createContext<ConnectionControls | null>(null);

/** Holds the connection, starting from the one this install remembers. */
export function ConnectionProvider({ children }: { readonly children: ReactNode }) {
  const [connection, setConnection] = useState<ServerConnection | null>(loadConnection);
  const [attempt, setAttempt] = useState(0);

  const value: ConnectionControls = {
    connection,
    connect: (next) => {
      saveConnection(next);
      setConnection(next);
      setAttempt(0);
    },
    disconnect: () => {
      saveConnection(null);
      setConnection(null);
      setAttempt(0);
    },
    reconnect: () => setAttempt((count) => count + 1),
    attempt,
  };

  return <ConnectionContext value={value}>{children}</ConnectionContext>;
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

/** The connected server, its origin for media URLs, and the ways to switch, leave, or reopen it. */
export interface Connection extends ServerConnection {
  readonly connect: (connection: ServerConnection) => void;
  readonly disconnect: () => void;
  readonly reconnect: () => void;
}

/**
 * The connected server. Use it below the connected part of the app, where a server is known.
 *
 * @throws When no server is connected, a programming error.
 */
export const useConnection = (): Connection => {
  const { connection, connect, disconnect, reconnect } = useConnectionControls();

  if (connection === null) throw new Error("useConnection needs a connected server");

  return {
    origin: connection.origin,
    convexUrl: connection.convexUrl,
    connect,
    disconnect,
    reconnect,
  };
};
