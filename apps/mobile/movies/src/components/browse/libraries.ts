import { usePlatform } from "@media/sdk/react";
import { useMemo } from "react";

import { useAllPages } from "@media/mobile-core/pages";
import type { Paged } from "@media/mobile-core/pages";

import type { Library, Scan } from "@/lib/owner";
import { isActive } from "@/lib/scans";

/** A library that is scanning now, and its scan. */
export interface ActiveScan {
  readonly library: Library;
  readonly scan: Scan;
}

/** The movies libraries shared with this person, every page of them. */
export const useMovieLibraries = (): Paged<Library> => {
  const platform = usePlatform();

  const paged = useAllPages(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  return useMemo(
    () =>
      paged.status === "ready"
        ? { ...paged, rows: paged.rows.filter((library) => library.kind === "movies") }
        : paged,
    [paged],
  );
};

/**
 * The scans running or queued now in `libraries`, read from the list's rows, as the movies web
 * client's scan toast reads them. A row from a server that does not send its scan counts as not
 * scanning.
 */
export const useActiveScans = (libraries: ReadonlyArray<Library>): ReadonlyArray<ActiveScan> =>
  useMemo(
    () =>
      libraries.flatMap((library): ReadonlyArray<ActiveScan> => {
        const scan = library.scan ?? null;

        return scan !== null && isActive(scan) ? [{ library, scan }] : [];
      }),
    [libraries],
  );
