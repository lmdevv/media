/**
 * Whether the Convex socket is up, as the session router follows it: it moves the session onto
 * the phone when the socket drops while the phone plays it, and hands it back once the socket is up.
 */
import type { ConnectionSignal } from "@music/player/session-router";
import type { ConvexReactClient } from "convex/react";

/** The part of the Convex client the signal reads. */
export type ConnectionSource = Pick<
  ConvexReactClient,
  "connectionState" | "subscribeToConnectionState"
>;

/**
 * The socket's state from `client`. Convex reports every change to its connection state, such as
 * each request it sends; listeners hear only when the socket goes up or down.
 */
export const convexConnection = (client: ConnectionSource): ConnectionSignal => ({
  connected: () => client.connectionState().isWebSocketConnected,
  subscribe: (listener) => {
    let connected = client.connectionState().isWebSocketConnected;

    return client.subscribeToConnectionState((state) => {
      if (state.isWebSocketConnected === connected) return;
      connected = state.isWebSocketConnected;
      listener();
    });
  },
});
