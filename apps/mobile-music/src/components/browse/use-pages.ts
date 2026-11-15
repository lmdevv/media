import { useAllPages, usePages as useCorePages } from "@media/mobile-core/pages";
import type { Paged, PagedQuery, PageOpts } from "@media/mobile-core/pages";

import type { AlbumCard, ArtistCard, Track } from "@/lib/models";
import { useMusic } from "@/lib/platform";

type ChainStatus =
  /** A page is still loading; the items before it are shown. */
  | { readonly kind: "loading" }
  /** Every page so far has loaded, and more follow. */
  | { readonly kind: "more" }
  /** Every page has loaded and the last is the end of the list. */
  | { readonly kind: "done" };

/** A list loaded a page at a time. */
export interface Pages<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly status: ChainStatus;
  /** Loads the next page, if there is one and none is loading. */
  readonly loadMore: () => void;
}

/** How a list reads its pages. */
interface PagesOptions {
  /** Rows per page. */
  readonly limit: number;
  /** Load every page now, for an order the server doesn't page in. */
  readonly all: boolean;
}

const noMore = (): void => {};

const pageArgs = (paginationOpts: PageOpts) => ({ paginationOpts });

const pagesOf = <Item>(paged: Paged<Item>): Pages<Item> => {
  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status === "loading")
    return { items: [], status: { kind: "loading" }, loadMore: noMore };

  const { next } = paged;

  if (next.kind === "failed") throw new Error(next.message);

  if (next.kind === "done")
    return { items: paged.rows, status: { kind: "done" }, loadMore: noMore };

  return {
    items: paged.rows,
    status: next.kind === "more" ? { kind: "more" } : { kind: "loading" },
    loadMore: next.kind === "more" ? next.load : noMore,
  };
};

const usePages = <Item>(
  query: PagedQuery<{ readonly paginationOpts: PageOpts }, Item>,
  { limit, all }: PagesOptions,
): Pages<Item> => {
  const some = useCorePages(query, all ? "skip" : pageArgs, limit);
  const every = useAllPages(query, all ? pageArgs : "skip", limit);

  return pagesOf(all ? every : some);
};

/** The albums you may play, newest first, a page at a time. */
export const useAlbumPages = (options: PagesOptions): Pages<AlbumCard> =>
  usePages(useMusic().albums.list, options);

/** The artists you may play, by name, a page at a time. */
export const useArtistPages = (options: PagesOptions): Pages<ArtistCard> =>
  usePages(useMusic().artists.list, options);

/** The songs you may play, by title, a page at a time. */
export const useTrackPages = (options: PagesOptions): Pages<Track> =>
  usePages(useMusic().tracks.list, options);
