/** How far a job got, as the core reports a library's scan or an import's job. */
export interface JobProgress {
  readonly status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  readonly done: number | null;
  readonly total: number | null;
}

/** A scan's progress as the UI shows it. */
export interface ScanProgress {
  /** Fraction done from 0 to 1; null while the total is still unknown. */
  readonly fraction: number | null;
  readonly done: number;
  readonly total: number | null;
}

/** Progress of `job`. A finished job is complete; counts the core hides read as none yet. */
export const scanProgress = (job: JobProgress): ScanProgress => {
  const done = job.done ?? 0;
  const { total } = job;

  if (job.status === "succeeded") return { fraction: 1, done, total };

  const fraction = total === null || total <= 0 ? null : Math.min(1, done / total);

  return { fraction, done, total };
};

/** Whether a job is still queued or running. */
export const isActive = (job: Pick<JobProgress, "status">): boolean =>
  job.status === "queued" || job.status === "running";
