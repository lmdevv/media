import type { Job } from "@media/contracts/models/jobs";
import { folderTroubleOf } from "@media/contracts/scan-failure";
import type { FolderTrouble } from "@media/contracts/scan-failure";

import { formatCount } from "./owner-format";

/** Whether a job is still queued or running. */
export const isActive = (job: Job | undefined): boolean =>
  job !== undefined && (job.status === "pending" || job.status === "running");

/** Whether a job ended without finishing. */
export const isStopped = (job: Job): boolean =>
  job.status === "failed" || job.status === "cancelled";

/**
 * Whether a failed scan could not read the library's folders, such as a NAS share gone offline
 * (I05), or was refused a folder outside the server's approved roots (I17).
 */
export const folderTrouble = (job: Job | undefined): FolderTrouble | null =>
  job?.status === "failed" ? folderTroubleOf(job.error) : null;

const STATE_LABELS = {
  pending: "Queued",
  running: "Scanning",
  succeeded: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
} as const satisfies Record<Job["status"], string>;

/** A scan's state as a row's detail: `Complete`, `Scanning`, `Failed`. */
export const scanStateLabel = (job: Job): string => STATE_LABELS[job.status];

/** How far a scan has come once its file count is known: `42 of 186` and the fraction. */
export const scanCount = (
  job: Job,
): { readonly label: string; readonly fraction: number } | null => {
  const { done, total } = job.progress;

  if (job.status === "succeeded") {
    const count = total ?? done;

    return { label: `${formatCount(count)} of ${formatCount(count)}`, fraction: 1 };
  }

  if (total === null || total <= 0) return null;

  return {
    label: `${formatCount(done)} of ${formatCount(total)}`,
    fraction: Math.min(1, done / total),
  };
};

const phaseLine = (phase: string | null): string => {
  if (phase === "walking") return "Finding files.";

  if (phase === "reconciling") return "Checking for files that moved or left.";

  if (phase === "done") return "Finishing up.";

  return "Matching titles and reading media.";
};

/** The line under a scan's count: what it is doing now, or how it ended. */
export const scanLine = (job: Job): string => {
  if (job.status === "pending") return "Waiting for the media service.";

  if (job.status === "succeeded") return "Scan complete.";

  if (job.status === "cancelled") return "The scan was cancelled.";

  if (job.status === "failed") return job.error ?? "The scan stopped.";

  return phaseLine(job.progress.message);
};
