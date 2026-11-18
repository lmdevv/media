/** How far a job got, as the core reports a library's scan or an import's job. */
export interface JobProgress {
  readonly status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  readonly done: number | null;
  readonly total: number | null;
  /** When the attempt running now started; null unless it runs. */
  readonly startedAt: number | null;
}

/** A scan's progress as the UI shows it. */
export interface ScanProgress {
  /** Fraction done from 0 to 1; null while the total is still unknown. */
  readonly fraction: number | null;
  readonly done: number;
  readonly total: number | null;
  /** Whole minutes left at the pace since it started, at least 1; null before there is a pace. */
  readonly minutesLeft: number | null;
}

/**
 * Progress of `job` at `now` (epoch milliseconds). A finished job is complete; counts the core
 * hides read as none yet.
 */
export const scanProgress = (job: JobProgress, now: number): ScanProgress => {
  const done = job.done ?? 0;
  const { total } = job;

  if (job.status === "succeeded") return { fraction: 1, done, total, minutesLeft: null };

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

/** Whether a job is still queued or running. */
export const isActive = (job: Pick<JobProgress, "status">): boolean =>
  job.status === "queued" || job.status === "running";
