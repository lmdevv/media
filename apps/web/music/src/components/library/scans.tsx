import { usePlatform } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";

import { isActive } from "@/lib/job-progress";
import type { Scan } from "@/lib/job-progress";
import { useAllRows } from "@/lib/pages";

type Library = Awaited<ReturnType<PlatformSdk["core"]["libraries"]["list"]>>["page"][number];

/** A music library's scan that is waiting or running, with the library's name. */
export interface ActiveScan extends Scan {
  readonly library: string;
}

/**
 * The first waiting or running scan of a music library among the list's rows, in its order; null
 * when none runs. A row from a server that does not send its scan counts as not scanning.
 */
export const firstActiveScan = (libraries: ReadonlyArray<Library>): ActiveScan | null => {
  for (const library of libraries) {
    const scan = library.scan ?? null;

    if (library.kind === "music" && scan !== null && isActive(scan)) {
      return { ...scan, library: library.name };
    }
  }

  return null;
};

/**
 * The first waiting or running scan of a music library shared with you, null when none runs, or
 * `undefined` while the libraries load. The library list carries each library's latest scan.
 */
export const useActiveScan = (): ActiveScan | null | undefined => {
  const platform = usePlatform();

  const libraries = useAllRows(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  return libraries === undefined ? undefined : firstActiveScan(libraries);
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
