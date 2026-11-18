import { useFirstRows } from "@media/mobile-core/pages";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";

import { useMovieLibraries } from "@/components/browse/libraries";

/** Collections Home's Collections row shows. */
export const ROW_COLLECTIONS = 20;

/** Home's rows: Continue Watching, Recently Added, My List, and the hero's titles. */
export const useHomeRows = () => {
  const platform = usePlatform();

  return usePlatformQuery(platform.movies.titles.home);
};

/** The first collections, for Home's Collections row. */
export const useRowCollections = () => {
  const platform = usePlatform();

  return useFirstRows(
    platform.movies.collections.list,
    (paginationOpts) => ({ paginationOpts }),
    ROW_COLLECTIONS,
  );
};

/**
 * Keeps Home's queries open, through the same hooks Home reads them with, so Home finds their
 * answers when it mounts. Renders nothing and reads no answer. It sits above every error boundary,
 * so it calls only hooks that keep a failure as state.
 */
export function HeldHome() {
  useHomeRows();
  useMovieLibraries();
  useRowCollections();

  return null;
}
