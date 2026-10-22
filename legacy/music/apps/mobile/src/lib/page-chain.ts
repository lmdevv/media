/**
 * A cursor-paginated list read as a chain of live pages, as the web reads it: each page starts at
 * a cursor and, once the page after it exists, ends where that one starts (`end`), so a row added
 * while the list is open lands in exactly one page. These are the pure rules; the hook that
 * subscribes to the pages lives with the screens.
 */

/** One page of a cursor-paginated command. */
export interface PageResult<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly cursor: string;
  readonly done: boolean;
}

/** Where each page of a chain starts, in order; the first page starts at null. */
export type Cursors = ReadonlyArray<string | null>;

/** The chain before any page has loaded. */
export const FIRST_PAGE: Cursors = [null];

/** The key a page is subscribed and held under. */
export const keyOf = (cursor: string | null): string => cursor ?? "first";

/** Where a page starts, and where the page after it starts once there is one. */
interface PageBounds {
  readonly cursor: string | null;
  readonly end: string | null;
}

/** The bounds the page at `index` reads: its own cursor, and the next page's start as its end. */
export const pageBounds = (cursors: Cursors, index: number): PageBounds => ({
  cursor: cursors[index] ?? null,
  end: cursors[index + 1] ?? null,
});

/**
 * The chain's cursors after the page at `cursor` reported that it ends at `next`. A page that is
 * not the last ends where the following page starts, unless it outgrew the most rows one page
 * holds; then a page starting at `next` goes in between, so no row falls out of the list.
 */
export const splitChain = (cursors: Cursors, cursor: string | null, next: string): Cursors => {
  const at = cursors.indexOf(cursor);

  if (at === -1 || at === cursors.length - 1 || cursors.includes(next)) return cursors;

  return [...cursors.slice(0, at + 1), next, ...cursors.slice(at + 1)];
};

/** What a chain shows, from its pages in order. */
export type ChainStatus =
  /** A page in the chain is still loading; the items before it are shown. */
  | { readonly kind: "loading" }
  /** Every page has loaded and the last says more follow, starting at `next`. */
  | { readonly kind: "more"; readonly next: string }
  /** Every page has loaded and the last is the end of the list. */
  | { readonly kind: "done" };

/** A chain's rows and whether the list goes on. */
export interface ChainView<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly status: ChainStatus;
}

/**
 * The rows of the loaded pages up to the first one still loading, so the list never shows a hole,
 * and whether more follow. Pages may be empty while more follow (their rows were in libraries
 * this account can't read), so only the last page's `done` ends the list.
 */
export const joinChain = <Item>(
  cursors: Cursors,
  pageAt: (cursor: string | null) => PageResult<Item> | undefined,
): ChainView<Item> => {
  const items: Array<Item> = [];

  for (const [index, cursor] of cursors.entries()) {
    const page = pageAt(cursor);

    if (page === undefined) return { items, status: { kind: "loading" } };

    items.push(...page.items);

    if (index === cursors.length - 1) {
      return { items, status: page.done ? { kind: "done" } : { kind: "more", next: page.cursor } };
    }
  }

  return { items, status: { kind: "loading" } };
};

/** The chain's cursors once every loaded page that outgrew its bounds has split off its rest. */
export const reconcileChain = (
  cursors: Cursors,
  pageAt: (cursor: string | null) => PageResult<unknown> | undefined,
): Cursors =>
  cursors.reduce<Cursors>((chain, cursor) => {
    const page = pageAt(cursor);

    return page === undefined ? chain : splitChain(chain, cursor, page.cursor);
  }, cursors);

/** The chain with the page that starts at `next` added, unless it is already there. */
export const extendChain = (cursors: Cursors, next: string): Cursors =>
  cursors.includes(next) ? cursors : [...cursors, next];

/**
 * Reads a paginated list once, page after page, until it ends or holds `max` items. Each request
 * needs the previous page's cursor, so pages load one after another.
 */
export const readPages = async <Item>(
  read: (cursor: string | null) => Promise<PageResult<Item>>,
  max: number,
): Promise<ReadonlyArray<Item>> => {
  const collect = async (
    cursor: string | null,
    loaded: ReadonlyArray<Item>,
  ): Promise<ReadonlyArray<Item>> => {
    const page = await read(cursor);

    // A page that says more follow must move the cursor, or this would ask for it forever.
    if (!page.done && page.cursor === cursor) {
      throw new Error("The list stopped advancing; load it again");
    }

    const items = [...loaded, ...page.items];

    return page.done || items.length >= max ? items.slice(0, max) : collect(page.cursor, items);
  };

  return collect(null, []);
};
