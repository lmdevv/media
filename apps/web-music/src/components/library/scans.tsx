import { usePlatform } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import type { QueryState } from "@media/sdk/react";
import { useEachQuery } from "@media/ui/lib/each-query";

import { isActive } from "@/lib/job-progress";
import type { Scan } from "@/lib/job-progress";
import { useAllRows } from "@/lib/pages";

type Library = Awaited<ReturnType<PlatformSdk["core"]["libraries"]["get"]>>;

/** A music library's scan that is waiting or running, with the library's name. */
export interface ActiveScan extends Scan {
  readonly library: string;
}

/**
 * The first waiting or running scan among the libraries' states, in the list's order; null when
 * none runs, or `undefined` while a library that could hold one still loads. A library the
 * person lost between the list and its own read holds no scan for them.
 */
export const firstActiveScan = (
  libraries: ReadonlyArray<QueryState<Library>>,
): ActiveScan | null | undefined => {
  for (const state of libraries) {
    if (state.status === "success" && state.data.scan !== null && isActive(state.data.scan)) {
      return { ...state.data.scan, library: state.data.name };
    }
  }

  return libraries.some((state) => state.status === "loading") ? undefined : null;
};

/**
 * The first waiting or running scan of a music library shared with you, null when none runs, or
 * `undefined` while the libraries load. Old music listed jobs; the core shows each library's
 * latest scan (`core.libraries.get`), which is the same for its one job kind, so every music
 * library is read at once.
 */
export const useActiveScan = (): ActiveScan | null | undefined => {
  const platform = usePlatform();

  const libraries = useAllRows(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const music = (libraries ?? [])
    .filter((library) => library.kind === "music")
    .map((library) => ({ libraryId: library.libraryId }));

  const states = useEachQuery(platform.core.libraries.get, music);

  return libraries === undefined ? undefined : firstActiveScan(states);
};

/** The thin accent progress bar used for scans. */
export function ProgressBar({
  percent,
  className = "h-1",
  label,
}: {
  readonly percent: number;
  readonly className?: string;
  readonly label: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`flex shrink-0 overflow-hidden rounded-full bg-border ${className}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
