import { useEachQuery } from "@media/mobile-core/each-query";
import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { useMemo } from "react";

import type { LibraryView } from "./first-scan";

const PAGE_ROWS = 100;

/**
 * Every page of the libraries shared with you. Both hooks below list through it, with the same
 * arguments, so they share one subscription when both are mounted.
 */
const useListed = () =>
  useAllPages(
    usePlatform().core.libraries.list,
    (paginationOpts) => ({ paginationOpts }),
    PAGE_ROWS,
  );

/**
 * The music libraries shared with you, each with what `core.libraries.get` shows of it, or
 * undefined while they load. A library whose read failed is left out.
 */
export const useMusicLibraries = (): ReadonlyArray<LibraryView> | undefined => {
  const platform = usePlatform();
  const listed = useListed();

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

/**
 * Whether a music library shared with you is being scanned or waits for one, from the list's rows;
 * undefined while they load. A row from a server that does not send its scan counts as not
 * scanning.
 */
export const useScanning = (): boolean | undefined => {
  const listed = useListed();

  if (listed.status !== "ready" || listed.next.kind !== "done") return undefined;

  return listed.rows.some(
    (row) =>
      row.kind === "music" && (row.scan?.status === "running" || row.scan?.status === "queued"),
  );
};
