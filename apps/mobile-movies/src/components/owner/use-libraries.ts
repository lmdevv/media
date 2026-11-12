import type { Paged } from "@media/mobile-core/pages";
import { useMemo } from "react";

import { useMovieLibraries } from "@/components/browse/libraries";
import type { Library } from "@/lib/owner";

/** The movies libraries this person manages, every page of them, as the owner screens list them. */
export const useManagedLibraries = (): Paged<Library> => {
  const libraries = useMovieLibraries();

  return useMemo(
    () =>
      libraries.status === "ready"
        ? { ...libraries, rows: libraries.rows.filter((library) => library.level === "manage") }
        : libraries,
    [libraries],
  );
};
