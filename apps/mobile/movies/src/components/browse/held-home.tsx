import { useFirstRows } from "@media/mobile-core/pages";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createContext, useContext } from "react";

import { useMovieLibraries } from "@/components/browse/libraries";

/**
 * Whether Home shows the rows this phone saved at an earlier launch, until the server answers. Its
 * play buttons then leave the episode to the server, which knows where the person is now.
 */
export const SavedHomeContext = createContext(false);

export const useSavedHome = (): boolean => useContext(SavedHomeContext);

/**
 * The queries a launch saves for the next one to show at once: who is signed in, and what Home
 * draws first (its rows, the libraries that decide its layout, and the Collections row). The
 * person's list and history, which Home's actions read, wait for the server.
 */
export const SAVED_QUERIES = [
  "core.auth.sessions.current",
  "movies.titles.home",
  "core.libraries.list",
  "movies.collections.list",
] as const;

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
