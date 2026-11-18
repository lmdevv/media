import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { useAllPages } from "@media/ui/lib/pages";
import type { Paged } from "@media/ui/lib/pages";
import { useMemo } from "react";

import { isActive } from "./scan-progress";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

type Libraries = PlatformSdk["core"]["libraries"];

/** A library shared with this person, as the core lists it. */
export type Library =
  Result<Libraries["list"]> extends { readonly page: ReadonlyArray<infer Row> } ? Row : never;

/** A library's latest scan. */
type Scan = NonNullable<Library["scan"]>;

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

const NO_LIBRARIES: ReadonlyArray<Library> = [];

/** The movies libraries this person manages, which they may scan. */
export const useManagedLibraries = (): ReadonlyArray<Library> => {
  const libraries = useMovieLibraries();

  return useMemo(
    () =>
      libraries.status === "ready"
        ? libraries.rows.filter((library) => library.level === "manage")
        : NO_LIBRARIES,
    [libraries],
  );
};

/**
 * The scans running or queued now in `libraries`, read from the list's rows. A row from a server
 * that does not send its scan counts as not scanning.
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
