import type { PlatformSdk } from "@media/sdk/promise";
import type { QueryState } from "@media/sdk/react";
import { usePlatform } from "@media/sdk/react";
import { useState, useSyncExternalStore } from "react";

/** A followed platform query, as a query method's `watch` returns it. */
interface Watch<Result> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => QueryState<Result>;
}

/** A platform query method with arguments `Args`, such as `platform.music.albums.get`. */
export interface Query<Args, Result> {
  (args: Args): Promise<Result>;
  readonly watch: (args: Args) => Watch<Result>;
}

const LOADING: QueryState<never> = { status: "loading" };

const skipped: Watch<never> = {
  subscribe: () => () => undefined,
  getSnapshot: () => LOADING,
};

/**
 * Follows a platform query's state, as `usePlatformQuery` does, for arguments that may be
 * `"skip"`. The watch is held in state, keyed by the query and its arguments, since React may drop
 * a memo, which would restart a live subscription.
 */
export const useQueryState = <Args, Result>(
  query: Query<Args, Result>,
  args: Args | "skip",
): QueryState<Result> => {
  const key = args === "skip" ? null : JSON.stringify(args);
  const watchFor = (): Watch<Result> => (args === "skip" ? skipped : query.watch(args));
  const [held, setHeld] = useState(() => ({ query, key, watch: watchFor() }));
  let current = held;

  if (held.query !== query || held.key !== key) {
    current = { query, key, watch: watchFor() };
    setHeld(current);
  }

  const { watch } = current;

  return useSyncExternalStore(watch.subscribe, watch.getSnapshot, watch.getSnapshot);
};

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * Follows a platform query: its result, or `undefined` while it loads. Pass `"skip"` to wait. A
 * failure throws to the route's error boundary, as old music's reads did, after the SDK's own
 * retries of network failures.
 */
export const useRead = <Args, Result>(
  query: Query<Args, Result>,
  args: Args | "skip",
): Result | undefined => {
  const state = useQueryState(query, args);

  if (state.status === "error") throw asError(state.error);

  return state.status === "success" ? state.data : undefined;
};

/**
 * Like `useRead`, but a failure comes back as an `Error` instead of being thrown. For hooks above
 * every error boundary, such as the session phase, and for screens that show a failure in place.
 */
export const useReadSettled = <Args, Result>(
  query: Query<Args, Result>,
  args: Args | "skip",
): Result | Error | undefined => {
  const state = useQueryState(query, args);

  if (state.status === "error") return asError(state.error);

  return state.status === "success" ? state.data : undefined;
};

/** The core's music commands, as Promise methods. */
export const useMusic = (): PlatformSdk["music"] => usePlatform().music;

/** The core's own commands, as Promise methods. */
export const useCore = (): PlatformSdk["core"] => usePlatform().core;
