import type { QueryState } from "@media/sdk/react";

const NO_ROWS: ReadonlyArray<never> = [];

/** A list query's rows, null while it loads; one that failed lists nothing rather than loading forever. */
export const listOrLoading = <A>(state: QueryState<ReadonlyArray<A>>): ReadonlyArray<A> | null => {
  if (state.status === "success") return state.data;

  return state.status === "error" ? NO_ROWS : null;
};

/**
 * A query's arguments, or `"skip"` to wait while there are none, as `usePlatformQuery` takes them
 * spread: `usePlatformQuery(platform.movies.titles.search, ...orSkip(typed ? { query } : null))`.
 */
export const orSkip = <Args>(args: Args | null): readonly [Args] | readonly ["skip"] =>
  args === null ? ["skip"] : [args];
