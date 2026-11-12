import { useAllPages } from "@media/mobile-core/pages";
import type { Paged } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { useMemo } from "react";

import { managedMovieLibraries } from "@/lib/owner";
import type { Library } from "@/lib/owner";

/** The movies libraries this person manages, every page of them, as the owner screens list them. */
export const useManagedLibraries = (): Paged<Library> => {
  const platform = usePlatform();

  const libraries = useAllPages(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  return useMemo(
    () =>
      libraries.status === "ready"
        ? { ...libraries, rows: managedMovieLibraries(libraries.rows) }
        : libraries,
    [libraries],
  );
};
