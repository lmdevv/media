import { usePlatform } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import { useState, useSyncExternalStore } from "react";

/** A followed query, as a core query's `watch` returns it. */
interface Watch<Result> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => QueryState<Result>;
}

/** A core query method with no required arguments or with `Args`, such as `platform.music.albums.get`. */
interface Query<Args, Result> {
  (args: Args): Promise<Result>;
  readonly watch: (args: Args) => Watch<Result>;
}

const LOADING: QueryState<never> = { status: "loading" };

const skipped: Watch<never> = {
  subscribe: () => () => undefined,
  getSnapshot: () => LOADING,
};

/**
 * Follows a core query's state, as `usePlatformQuery` does, for arguments that may be `"skip"`.
 * The watch is held in state, keyed by the query and its arguments, since React may drop a memo,
 * which would restart a live subscription.
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

/**
 * Follows a core query: its result, or `undefined` while it loads. Pass `"skip"` to wait. A
 * failure throws to the route's error screen, as old music's reads did, after the SDK's own
 * retries of network failures.
 */
export const useRead = <Args, Result>(
  query: Query<Args, Result>,
  args: Args | "skip",
): Result | undefined => {
  const state = useQueryState(query, args);

  if (state.status === "error") throw state.error;

  return state.status === "success" ? state.data : undefined;
};

/** The core's music commands, as Promise methods. */
export const useMusic = (): PlatformSdk["music"] => usePlatform().music;

/** Who is signed in, as `core.auth.sessions.current` answers. */
export type Me = Awaited<ReturnType<PlatformSdk["core"]["auth"]["sessions"]["current"]>>;

/** The signed-in person and their session, or `undefined` while it loads. */
export const useMe = (): Me | undefined => {
  const platform = usePlatform();

  return useRead(platform.core.auth.sessions.current, {});
};

/** The name a person goes by: the display name they set, else their username. */
export const nameOf = (person: Pick<Me, "username" | "displayName">): string =>
  person.displayName ?? person.username;
