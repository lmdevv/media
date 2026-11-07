/**
 * A query's state as a page reads it: the SDK's `QueryState`, with the failure left as whatever
 * the page tells apart by its tag.
 */
export type Lookup<Found> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: Found }
  | { readonly status: "error"; readonly error: unknown; readonly retry: () => void };
