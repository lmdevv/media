/**
 * The Convex connection over the app's `ConvexReactClient`, the client `convex/react` hooks use
 * too, so screens and SDK workflows share one WebSocket and one session.
 */
import type { ConvexReactClient } from "convex/react";
import { Effect } from "effect";
import type { Layer } from "effect";

import * as ConvexTransport from "./convex-transport";
import type { AuthTokenSource, ClientAdapter } from "./convex-transport";

const reactAdapter = (client: ConvexReactClient): ClientAdapter => {
  const fetchers = ConvexTransport.clientTokenFetchers();

  const subscribe = ConvexTransport.heldSubscribe(fetchers, (path, args, onValue, onError) => {
    const watch = client.watchQuery(ConvexTransport.reference("query", path), args);

    const read = (): void => {
      try {
        const value = watch.localQueryResult();

        if (value !== undefined) onValue(value);
      } catch (cause) {
        onError(cause instanceof Error ? cause : new Error("Query failed", { cause }));
      }
    };

    const unsubscribe = watch.onUpdate(read);

    read();

    return unsubscribe;
  });

  return {
    call: ConvexTransport.heldCall(fetchers, (kind, path, args, signal) =>
      kind === "query"
        ? ConvexTransport.queryOnce(subscribe, path, args, signal)
        : ConvexTransport.callByKind(client, kind, path, args),
    ),
    subscribe,
    setAuth: (source: AuthTokenSource | null) =>
      fetchers.install(source, (fetcher) => {
        if (fetcher === null) client.clearAuth();
        else client.setAuth(fetcher);
      }),
    close: () => {
      fetchers.retire();

      return Promise.resolve();
    },
  };
};

/**
 * The connection over `client`. Closing it stops refreshing the session's token but leaves
 * `client` open: the app owns it.
 */
export const layer = (client: ConvexReactClient): Layer.Layer<ConvexTransport.ConvexTransport> =>
  ConvexTransport.layerFromAdapter(Effect.sync(() => reactAdapter(client)));
