/**
 * Scan jobs as the administration screens word them (F18, F19, G09): which phase a job is in, its
 * progress and time left, and the status lines under its rows. Each takes `now` so a test can pin
 * the clock.
 */
import type { Job, JobStatus } from "@music/commands/models";

import { countOf } from "./format";
import { ago, dayOf } from "./when";

/**
 * Where a job is in its life: still going (`active`: waiting or running), finished, or stopped
 * before the end (failed or cancelled). Each phase has its own screen state (F19, G09).
 */
export type JobPhase = "active" | "done" | "stopped";

const PHASES: Readonly<Record<JobStatus, JobPhase>> = {
  pending: "active",
  running: "active",
  done: "done",
  failed: "stopped",
  cancelled: "stopped",
};

/** The phase a status belongs to. */
export const jobPhase = (status: JobStatus): JobPhase => PHASES[status];

const grouped = new Intl.NumberFormat("en-US");

/** Percent complete, or null while the total is unknown. A finished job is 100. */
export const jobPercent = (job: Pick<Job, "status" | "done" | "total">): number | null => {
  if (job.status === "done") return 100;

  if (job.total === null || job.total === 0) return null;

  return Math.min(100, Math.floor((job.done / job.total) * 100));
};

/** The big number on a job's page, its caption, and how full the bar is (F19). */
export interface JobProgress {
  readonly stat: string;
  readonly caption: string;
  /** Percent of the bar to fill; null hides the bar while the total is unknown. */
  readonly fill: number | null;
}

/** A job's progress as F19 shows it: `64%` over `804 of 1,248 files read`. */
export const jobProgress = (job: Pick<Job, "status" | "done" | "total">): JobProgress => {
  if (job.status === "pending") return { stat: "0%", caption: "Waiting for the scanner", fill: 0 };

  // A rescan that found nothing changed finishes with nothing counted.
  if (job.status === "done" && job.done === 0) {
    return { stat: "100%", caption: "Nothing new to read", fill: 100 };
  }

  const percent = jobPercent(job);

  if (percent === null) {
    return { stat: grouped.format(job.done), caption: "Files read so far", fill: null };
  }

  const caption =
    job.total === null
      ? `${countOf(job.done, "file")} read`
      : `${grouped.format(job.done)} of ${countOf(job.total, "file")} read`;

  return { stat: `${String(percent)}%`, caption, fill: percent };
};

/**
 * Time left from the rate so far (F19): `About 2 minutes left`, or null until a running job has
 * read enough to tell.
 */
export const jobEta = (
  job: Pick<Job, "status" | "done" | "total" | "startedAt">,
  now: number,
): string | null => {
  if (job.status !== "running" || job.total === null || job.startedAt === null) return null;

  if (job.done === 0 || job.done >= job.total) return null;

  const rate = job.done / Math.max(1, now - job.startedAt);
  const minutes = Math.ceil((job.total - job.done) / rate / 60_000);

  return minutes <= 1 ? "Less than a minute left" : `About ${countOf(minutes, "minute")} left`;
};

/** When a job last changed state: its finish, else its start, else when it was queued. */
const lastChange = (job: Pick<Job, "createdAt" | "startedAt" | "finishedAt">): number =>
  job.finishedAt ?? job.startedAt ?? job.createdAt;

/** A running job's row: its counts once the scanner has them, its own words before. */
const runningLine = (job: Job): string => {
  const percent = jobPercent(job);

  if (job.total === null || percent === null) return job.message ?? "Starting";

  return `${grouped.format(job.done)} / ${countOf(job.total, "file")} · ${String(percent)}%`;
};

/**
 * A job row's subtitle per status (F18): `804 / 1,248 files · 64%`, `Completed · 142 files ·
 * Today`, `Failed · Folder unavailable · Yesterday`, `Cancelled · Today`.
 */
const LINES: Readonly<Record<JobStatus, (job: Job, day: string) => string>> = {
  pending: () => "Waiting for the scanner",
  running: runningLine,
  done: (job, day) =>
    `Completed · ${job.done === 0 ? "Nothing new" : countOf(job.done, "file")} · ${day}`,
  failed: (job, day) => `Failed · ${job.error ?? "Stopped unexpectedly"} · ${day}`,
  cancelled: (_job, day) => `Cancelled · ${day}`,
};

/** A job row's subtitle (F18), with the day it last changed. */
export const jobLine = (job: Job, now: number): string =>
  LINES[job.status](job, dayOf(lastChange(job), now));

/**
 * The status under a job's title on its own page, per status (F19): `Running · Started 3 minutes
 * ago`, `Waiting · Queued just now`, `Done · Finished yesterday`.
 */
const STATUS_LINES: Readonly<Record<JobStatus, (job: Job, now: number) => string>> = {
  pending: (job, now) => `Waiting · Queued ${ago(job.createdAt, now)}`,
  running: (job, now) => `Running · Started ${ago(job.startedAt ?? job.createdAt, now)}`,
  done: (job, now) => `Done · Finished ${ago(lastChange(job), now)}`,
  failed: (job, now) => `Failed · Stopped ${ago(lastChange(job), now)}`,
  cancelled: (job, now) => `Cancelled · Stopped ${ago(lastChange(job), now)}`,
};

/** The status line under a job's title on its own page (F19). */
export const jobStatusLine = (job: Job, now: number): string => STATUS_LINES[job.status](job, now);

/** What a stopped scan kept, as G09's notice says it: `804 songs were added`. */
export const keptLine = (done: number): string => {
  if (done === 0) return "No songs were added";

  return `${countOf(done, "song")} ${done === 1 ? "was" : "were"} added`;
};

/** Why a scan stopped, for G09's notice: the server's error, or that someone cancelled it. */
export const stoppedReason = (job: Pick<Job, "status" | "error">): string => {
  if (job.error !== null) return job.error;

  return job.status === "cancelled"
    ? "Someone stopped this scan. Songs already added stay in your library."
    : "The scan stopped before it finished.";
};

/** F18's two sections: jobs still going, and the rest. */
export interface JobSections {
  readonly running: ReadonlyArray<Job>;
  readonly recent: ReadonlyArray<Job>;
}

/** Jobs still going, then the rest, each in the server's newest-first order (F18). */
export const splitJobs = (jobs: ReadonlyArray<Job>): JobSections => ({
  running: jobs.filter((job) => jobPhase(job.status) === "active"),
  recent: jobs.filter((job) => jobPhase(job.status) !== "active"),
});
