import { useEachQuery } from "@media/mobile-core/each-query";
import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { useMemo } from "react";

import type { LibraryView } from "./first-scan";

/** Libraries asked for per page; a household keeps few. */
const PAGE_ROWS = 100;

/**
 * The music libraries shared with you, each with what `core.libraries.get` shows of it, or
 * undefined while they load. A library whose read failed shows without its view.
 */
export const useMusicLibraries = (): ReadonlyArray<LibraryView> | undefined => {
  const platform = usePlatform();

  const listed = useAllPages(
    platform.core.libraries.list,
    (paginationOpts) => ({ paginationOpts }),
    PAGE_ROWS,
  );

  const rows =
    listed.status === "ready" && listed.next.kind === "done"
      ? listed.rows.filter((row) => row.kind === "music")
      : null;

  const ids = useMemo(() => (rows ?? []).map((row) => ({ libraryId: row.libraryId })), [rows]);
  const views = useEachQuery(platform.core.libraries.get, ids);

  return useMemo(() => {
    if (rows === null || views.some((view) => view.status === "loading")) return undefined;

    return views.flatMap((view) => (view.status === "success" ? [view.data] : []));
  }, [rows, views]);
};

/** Whether a music library you may read is being scanned now, or undefined while that loads. */
export const useScanning = (): boolean | undefined =>
  useMusicLibraries()?.some(
    (library) => library.scan?.status === "running" || library.scan?.status === "queued",
  );
