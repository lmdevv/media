import type { Job } from "@music/commands/models";

import { formatCount } from "./format";

/** Percent complete for a job, or null while the total is unknown. */
export const jobPercent = (job: Pick<Job, "done" | "total" | "status">): number | null => {
  if (job.status === "done") return 100;

  if (job.total === null || job.total === 0) return null;

  return Math.min(100, Math.floor((job.done / job.total) * 100));
};

/**
 * `~6 MIN LEFT` from a running job's progress rate, or null until there is enough to estimate.
 * A job that is no longer running, or has read everything it counted, has nothing left.
 */
export const jobEta = (
  job: Pick<Job, "done" | "total" | "startedAt" | "status">,
  now: number,
): string | null => {
  if (job.status !== "running") return null;

  if (job.total === null || job.startedAt === null || job.done === 0) return null;

  if (job.done >= job.total) return null;

  const rate = job.done / Math.max(1, now - job.startedAt);
  const minutes = Math.ceil((job.total - job.done) / rate / 60_000);

  return minutes <= 1 ? "UNDER A MINUTE LEFT" : `~${formatCount(minutes)} MIN LEFT`;
};
