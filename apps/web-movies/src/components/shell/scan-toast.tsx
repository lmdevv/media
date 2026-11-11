import { ProgressBar } from "@media/ui/components/progress-bar";
import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { formatCount } from "@/lib/format";
import { useNow } from "@media/ui/lib/use-now";
import { useActiveScans, useManagedLibraries } from "@/lib/libraries";
import { scanProgress } from "@/lib/scan-progress";

/**
 * The corner card while a movies library this person manages scans: the library, files scanned,
 * what the scan is doing, and time left. Hiding it lasts until the next scan starts.
 */
export function ScanToast() {
  const scans = useActiveScans(useManagedLibraries());
  const now = useNow(5000);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const active = scans.find((candidate) => !hidden.has(candidate.scan.jobId));

  if (active === undefined) return null;

  const { library, scan } = active;
  const progress = scanProgress(scan, now);

  return (
    <section
      aria-label="Library scan"
      className="fixed inset-x-4 bottom-28 z-30 flex flex-col gap-3.5 rounded-control border border-hairline bg-surface-raised px-4.5 pt-4.5 pb-4 shadow-overlay md:inset-x-auto md:right-8 md:bottom-8 md:w-95"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2.5 text-body/5 font-semibold text-text">
          <LoaderCircleIcon
            className="size-4.5 motion-safe:animate-spin"
            strokeWidth={1.75}
            aria-hidden
          />
          Scanning {library.name}
        </p>
        <p className="font-mono text-caption/caption text-text-muted tabular-nums">
          {progress.total === null
            ? formatCount(progress.done)
            : `${formatCount(progress.done)} / ${formatCount(progress.total)}`}
        </p>
      </div>
      <ProgressBar value={progress.fraction ?? 0} tone="surface" className="rounded-bar" />
      <div className="flex flex-col gap-1">
        {scan.message === null ? null : (
          <p className="truncate font-mono text-caption/caption text-text-muted">{scan.message}</p>
        )}
        <p className="text-label/label text-text-muted">
          {scan.status === "queued"
            ? "Waiting for the media service"
            : progress.minutesLeft === null
              ? "Working out the time left"
              : `About ${progress.minutesLeft} min left`}
        </p>
      </div>
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={() => setHidden((current) => new Set([...current, scan.jobId]))}
          className="flex h-8 cursor-pointer items-center rounded-control px-3 text-label/caption font-semibold text-text-muted hover:text-text"
        >
          Hide
        </button>
        <Link
          to="/admin/libraries/$libraryId"
          params={{ libraryId: library.libraryId }}
          className="flex h-8 items-center rounded-control border border-hairline px-3 text-label/caption font-semibold text-text hover:bg-text/6"
        >
          Details
        </Link>
      </div>
    </section>
  );
}
