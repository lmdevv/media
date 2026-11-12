import { folderTroubleOf } from "@media/contracts/scan-failure";
import type { FolderTrouble } from "@media/contracts/scan-failure";

import type { Scan } from "./owner";
import { formatCount } from "./owner-format";

/** A job's state, as the core reports a library's scan or an import's job. */
type JobStatus = Scan["status"];

/** Whether a job is still queued or running. */
export const isActive = (job: { readonly status: JobStatus } | null): boolean =>
  job !== null && (job.status === "queued" || job.status === "running");

/** Whether a scan ended without finishing. */
export const isStopped = (scan: Scan): boolean =>
  scan.status === "failed" || scan.status === "canceled";

/**
 * Whether a failed scan could not read the library's folders, such as a NAS share gone offline
 * (I05), or was refused a folder outside the server's approved roots (I17).
 */
export const folderTrouble = (scan: Scan | null): FolderTrouble | null =>
  scan?.status === "failed" ? folderTroubleOf(scan.error) : null;

const STATE_LABELS = {
  queued: "Queued",
  running: "Scanning",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Cancelled",
} as const satisfies Record<JobStatus, string>;

/** A scan's state as a row's detail: `Complete`, `Scanning`, `Failed`. */
export const scanStateLabel = (scan: Scan): string =>
  scan.canceling ? "Cancelling" : STATE_LABELS[scan.status];

/**
 * How far a scan has come once its file count is known: `42 of 186` and the fraction. Null while
 * the count is unknown, or hidden from a restricted editor.
 */
export const scanCount = (
  scan: Scan,
): { readonly label: string; readonly fraction: number } | null => {
  const { done, total } = scan;

  if (scan.status === "succeeded") {
    const count = total ?? done;

    return count === null
      ? null
      : { label: `${formatCount(count)} of ${formatCount(count)}`, fraction: 1 };
  }

  if (done === null || total === null || total <= 0) return null;

  return {
    label: `${formatCount(done)} of ${formatCount(total)}`,
    fraction: Math.min(1, done / total),
  };
};

const phaseLine = (message: string | null): string => {
  if (message === "walking") return "Finding files.";

  if (message === "reconciling") return "Checking for files that moved or left.";

  if (message === "done") return "Finishing up.";

  return "Matching titles and reading media.";
};

/** The line under a scan's count: what it is doing now, or how it ended. */
export const scanLine = (scan: Scan): string => {
  if (scan.canceling) return "Stopping the scan.";

  if (scan.status === "queued") return "Waiting for the media service.";

  if (scan.status === "succeeded") return "Scan complete.";

  if (scan.status === "canceled") return "The scan was cancelled.";

  if (scan.status === "failed") return scan.error ?? "The scan stopped.";

  return phaseLine(scan.message);
};
