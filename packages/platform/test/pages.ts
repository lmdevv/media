import type { PaginationResult } from "convex/server";

/** Loads one page of a list, as a client's query does. */
export type PageLoader<T> = (options: {
  readonly numItems: number;
  readonly cursor: string | null;
  readonly endCursor?: string;
}) => Promise<PaginationResult<T>>;

/** Every page from `cursor` on, as a client scrolling down loads them. */
export const allPages = async <T>(
  load: PageLoader<T>,
  numItems: number,
  cursor: string | null = null,
): Promise<ReadonlyArray<PaginationResult<T>>> => {
  const found = await load({ numItems, cursor });

  return found.isDone
    ? [found]
    : [found, ...(await allPages(load, numItems, found.continueCursor))];
};

/** The rows after `cursor` up to `endCursor`, split where a page asks, as a reactive page reloads. */
export const rowsBetween = async <T>(
  load: PageLoader<T>,
  numItems: number,
  cursor: string | null,
  endCursor: string,
): Promise<ReadonlyArray<T>> => {
  const found = await load({ numItems, cursor, endCursor });

  if (found.pageStatus !== "SplitRequired") return found.page;

  const split = found.splitCursor ?? null;

  if (split === null) throw new Error("A page asked for a split and gave no split cursor");

  return [
    ...(await rowsBetween(load, numItems, cursor, split)),
    ...(await rowsBetween(load, numItems, split, found.continueCursor)),
  ];
};

/** A loader that counts its calls, so a test can wait for each one's usage in the function log. */
export interface CountedLoader<T> {
  readonly load: PageLoader<T>;
  readonly calls: () => number;
}

/** `load`, counting its calls. */
export const counted = <T>(load: PageLoader<T>): CountedLoader<T> => {
  let calls = 0;

  return {
    load: async (options) => {
      calls += 1;

      return load(options);
    },
    calls: () => calls,
  };
};
