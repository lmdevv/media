import { usePlatform } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";

import { isActive } from "@/lib/job-progress";
import type { Scan } from "@/lib/job-progress";
import { useAllRows } from "@/lib/pages";
import { cn } from "@/lib/utils";

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
    <progress
      aria-label={label}
      max={100}
      value={percent}
      className={cn(
        "block w-full shrink-0 appearance-none overflow-hidden rounded-full bg-border",
        "[&::-webkit-progress-bar]:bg-border [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent [&::-webkit-progress-value]:transition-[width] [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-accent",
        className,
      )}
    />
  );
}
