import type { ConnectionState } from "convex/browser";
import { describe, expect, it } from "vitest";

import { convexConnection } from "./convex-connection";
import type { ConnectionSource } from "./convex-connection";

const DOWN: ConnectionState = {
  hasInflightRequests: false,
  isWebSocketConnected: false,
  timeOfOldestInflightRequest: null,
  hasEverConnected: false,
  connectionCount: 0,
  connectionRetries: 0,
  inflightMutations: 0,
  inflightActions: 0,
};

/** A Convex client's connection state that a test moves by hand. */
const fakeClient = () => {
  let state = DOWN;
  const listeners = new Set<(next: ConnectionState) => void>();

  const source: ConnectionSource = {
    connectionState: () => state,
    subscribeToConnectionState: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  const move = (change: Partial<ConnectionState>): void => {
    state = { ...state, ...change };

    for (const listener of listeners) listener(state);
  };

  return { source, move, listening: () => listeners.size };
};

describe("convexConnection", () => {
  it("reads whether the socket is up", () => {
    const client = fakeClient();
    const signal = convexConnection(client.source);

    expect(signal.connected()).toBe(false);
    client.move({ isWebSocketConnected: true });
    expect(signal.connected()).toBe(true);
  });

  it("tells listeners only when the socket goes up or down", () => {
    const client = fakeClient();
    const signal = convexConnection(client.source);
    let heard = 0;

    signal.subscribe(() => {
      heard += 1;
    });

    client.move({ isWebSocketConnected: true, hasEverConnected: true });
    client.move({ hasInflightRequests: true, inflightMutations: 1 });
    client.move({ hasInflightRequests: false, inflightMutations: 0 });
    expect(heard).toBe(1);

    client.move({ isWebSocketConnected: false, connectionRetries: 1 });
    client.move({ connectionRetries: 2 });
    expect(heard).toBe(2);
  });

  it("stops listening when unsubscribed", () => {
    const client = fakeClient();
    const unsubscribe = convexConnection(client.source).subscribe(() => {});

    expect(client.listening()).toBe(1);
    unsubscribe();
    expect(client.listening()).toBe(0);
  });
});
