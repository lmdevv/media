import type { Job } from "@music/commands/models";

import { formatCount } from "@/lib/format";

/** Percent complete for a job, or null while the total is unknown. */
export const jobPercent = (job: Pick<Job, "done" | "total" | "status">): number | null => {
  if (job.status === "done") return 100;

  if (job.total === null || job.total === 0) return null;

  return Math.min(100, Math.floor((job.done / job.total) * 100));
};

/** `~6 MIN LEFT` from the job's progress rate, or null until there is enough to estimate. */
export const jobEta = (
  job: Pick<Job, "done" | "total" | "startedAt">,
  now: number,
): string | null => {
  if (job.total === null || job.startedAt === null || job.done === 0) return null;

  const rate = job.done / Math.max(1, now - job.startedAt);
  const minutes = Math.ceil((job.total - job.done) / rate / 60_000);

  return minutes <= 1 ? "UNDER A MINUTE LEFT" : `~${formatCount(minutes)} MIN LEFT`;
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
