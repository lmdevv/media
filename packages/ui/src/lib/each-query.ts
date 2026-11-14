import type { QueryState } from "@media/sdk/react";
import { useState, useSyncExternalStore } from "react";

import type { Watch } from "@media/ui/lib/pages";

/** A core query that can be followed, such as `platform.core.libraries.get`. */
export interface WatchedQuery<Args, A> {
  readonly watch: (args: Args) => Watch<A>;
}

interface EachStore<A> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyArray<QueryState<A>>;
}

/**
 * One store over several followed queries, whose snapshot is each one's state in order. The
 * snapshot stays the same array until one of them changes, as `useSyncExternalStore` needs.
 */
export const eachStore = <A>(watches: ReadonlyArray<Watch<A>>): EachStore<A> => {
  let output: ReadonlyArray<QueryState<A>> | null = null;

  return {
    subscribe: (onChange) => {
      const stops = watches.map((watch) => watch.subscribe(onChange));

      return () => {
        for (const stop of stops) stop();
      };
    },
    getSnapshot: () => {
      const next = watches.map((watch) => watch.getSnapshot());

      if (output === null || next.some((state, index) => state !== output?.[index])) {
        output = next;
      }

      return output;
    },
  };
};

/**
 * Follows `query` once for each of `args`, such as each library's `core.libraries.get`, and
 * returns their states in the same order. All of them load at once, and one that fails leaves
 * the others. The store is held in state, keyed by the query and the arguments, since React may
 * drop a memo, which would restart every subscription.
 */
export const useEachQuery = <Args, A>(
  query: WatchedQuery<Args, A>,
  args: ReadonlyArray<Args>,
): ReadonlyArray<QueryState<A>> => {
  const key = JSON.stringify(args);
  const open = (): EachStore<A> => eachStore(args.map((each) => query.watch(each)));
  const [held, setHeld] = useState(() => ({ query, key, store: open() }));
  let current = held;

  if (held.query !== query || held.key !== key) {
    current = { query, key, store: open() };
    setHeld(current);
  }

  const { store } = current;

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};
