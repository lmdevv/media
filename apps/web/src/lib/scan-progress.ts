import type { Job } from "@media/contracts/models/jobs";

/** A scan job's progress as the UI shows it. */
export interface ScanProgress {
  /** Fraction done from 0 to 1; null while the total is still unknown. */
  readonly fraction: number | null;
  readonly done: number;
  readonly total: number | null;
  /** Whole minutes left at the current pace, at least 1; null before there is a pace. */
  readonly minutesLeft: number | null;
}

/** Progress of `job` at `now` (epoch milliseconds). A finished scan is complete. */
export const scanProgress = (job: Job, now: number): ScanProgress => {
  const { done, total } = job.progress;

  if (job.status === "succeeded") {
    return { fraction: 1, done, total, minutesLeft: null };
  }

  const fraction = total === null || total <= 0 ? null : Math.min(1, done / total);

  const minutesLeft =
    job.status !== "running" ||
    job.startedAt === null ||
    total === null ||
    done <= 0 ||
    done >= total
      ? null
      : Math.max(1, Math.round((((now - job.startedAt) / done) * (total - done)) / 60_000));

  return { fraction, done, total, minutesLeft };
};

/** Whether a job has stopped without finishing. */
export const isStopped = (job: Job): boolean =>
  job.status === "failed" || job.status === "cancelled";

/** Whether a job is still queued or running. */
export const isActive = (job: Job): boolean => job.status === "pending" || job.status === "running";
