import { useCallback, useEffect, useState } from "react";

import { splitChain } from "./split-chain";

/** One page from a cursor-paginated command. */
export interface PageResult<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly cursor: string;
  readonly done: boolean;
}

/** What a loaded page reported: how many items it shows and whether it is the last. */
interface PageReport {
  readonly items: number;
  readonly done: boolean;
}

/** The key a page is stored and rendered under. */
export const keyOf = (cursor: string | null): string => cursor ?? "first";

/** What a chain of pages shows as a whole. */
interface ChainSummary {
  /** Every page loaded so far is empty and the last one is done. */
  readonly empty: boolean;
  /** The index of the first page with items, which carries the list header; -1 if none yet. */
  readonly firstFilled: number;
}

/**
 * What a chain of pages shows, from each page's report in order (undefined while it loads): the
 * list is empty when every page is empty and the last is done, and the first page with items
 * carries a list header.
 */
export const summarizeChain = (reported: ReadonlyArray<PageReport | undefined>): ChainSummary => ({
  empty: reported.every((page) => page?.items === 0) && reported.at(-1)?.done === true,
  firstFilled: reported.findIndex((page) => (page?.items ?? 0) > 0),
});

/** A chain of pages: where each starts, and how pages ask for more and report what they show. */
interface PageChain extends ChainSummary {
  /** Where each page starts, in order; the first is null. */
  readonly cursors: ReadonlyArray<string | null>;
  /** Adds the page that starts at `next`, when the end of the list comes into view. */
  readonly more: (next: string) => void;
  /** Records what the page at `cursor` shows and where the page after it starts. */
  readonly report: (cursor: string | null, page: PageResult<unknown>) => void;
}

/**
 * The cursors of a list loaded page by page, and what each page reported. A page can be empty
 * while more follow (its rows were in libraries you can't read), so emptiness is a property of the
 * whole chain: every page loaded so far is empty and the last one is done.
 */
export const usePageChain = (): PageChain => {
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);
  const [reports, setReports] = useState<ReadonlyMap<string, PageReport>>(new Map());

  const more = useCallback((next: string) => {
    setCursors((list) => (list.includes(next) ? list : [...list, next]));
  }, []);

  const report = useCallback((cursor: string | null, page: PageResult<unknown>) => {
    const { items: shown, done, cursor: next } = page;
    const items = shown.length;

    setCursors((list) => splitChain(list, cursor, next));
    setReports((current) => {
      const previous = current.get(keyOf(cursor));

      if (previous?.items === items && previous.done === done) return current;

      return new Map(current).set(keyOf(cursor), { items, done });
    });
  }, []);

  return {
    cursors,
    more,
    report,
    ...summarizeChain(cursors.map((cursor) => reports.get(keyOf(cursor)))),
  };
};

/** Tells the chain what `page` shows, and where it ends, once it loads or changes. */
export const useReportPage = (
  cursor: string | null,
  page: PageResult<unknown> | undefined,
  report: (cursor: string | null, page: PageResult<unknown>) => void,
): void => {
  useEffect(() => {
    if (page !== undefined) report(cursor, page);
  }, [cursor, page, report]);
};
