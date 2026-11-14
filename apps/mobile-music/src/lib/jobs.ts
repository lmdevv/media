import type { PlatformSdk } from "@media/sdk/promise";

import { countOf } from "./format";
import { ago, dayOf } from "./when";

/** One of the server's jobs, as `core.jobs.list` lists it. */
export type Job = Awaited<ReturnType<PlatformSdk["core"]["jobs"]["list"]>>["page"][number];

type JobStatus = Job["status"];

/**
 * Where a job is in its life: still going (`active`: queued or running), finished, or stopped
 * before the end (failed or canceled). Each phase has its own screen state (F19, G09).
 */
export type JobPhase = "active" | "done" | "stopped";

const PHASES: Readonly<Record<JobStatus, JobPhase>> = {
  queued: "active",
  running: "active",
  succeeded: "done",
  failed: "stopped",
  canceled: "stopped",
};

/** The phase a status belongs to. */
export const jobPhase = (status: JobStatus): JobPhase => PHASES[status];

const KINDS: Readonly<Partial<Record<Job["kind"], string>>> = {
  "music.scan": "Library scan",
  "music.lyrics": "Lyrics lookup",
  "movies.scan": "Movies scan",
};

/** What a job is called: its library's name for a scan, else what it does. */
export const jobName = (job: Pick<Job, "kind" | "library">): string =>
  job.library?.name ?? KINDS[job.kind] ?? "Background job";

const grouped = new Intl.NumberFormat("en-US");

/** Percent complete, or null while the total is unknown. A finished job is 100. */
export const jobPercent = (job: Pick<Job, "status" | "done" | "total">): number | null => {
  if (job.status === "succeeded") return 100;

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
  if (job.status === "queued") return { stat: "0%", caption: "Waiting for the scanner", fill: 0 };

  if (job.status === "succeeded" && job.done === 0) {
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
 * read enough to tell. `startedAt` is when its running attempt started, which a scan's library
 * says.
 */
export const jobEta = (
  job: Pick<Job, "status" | "done" | "total">,
  startedAt: number | null,
  now: number,
): string | null => {
  if (job.status !== "running" || job.total === null || startedAt === null) return null;

  if (job.done === 0 || job.done >= job.total) return null;

  const rate = job.done / Math.max(1, now - startedAt);
  const minutes = Math.ceil((job.total - job.done) / rate / 60_000);

  return minutes <= 1 ? "Less than a minute left" : `About ${countOf(minutes, "minute")} left`;
};

const lastChange = (job: Pick<Job, "createdAt" | "finishedAt">): number =>
  job.finishedAt ?? job.createdAt;

const runningLine = (job: Job): string => {
  const percent = jobPercent(job);

  if (job.total === null || percent === null) return job.message ?? "Starting";

  return `${grouped.format(job.done)} / ${countOf(job.total, "file")} · ${String(percent)}%`;
};

const LINES: Readonly<Record<JobStatus, (job: Job, day: string) => string>> = {
  queued: () => "Waiting for the scanner",
  running: runningLine,
  succeeded: (job, day) =>
    `Completed · ${job.done === 0 ? "Nothing new" : countOf(job.done, "file")} · ${day}`,
  failed: (job, day) => `Failed · ${job.error ?? "Stopped unexpectedly"} · ${day}`,
  canceled: (_job, day) => `Cancelled · ${day}`,
};

/** A job row's subtitle (F18), with the day it last changed. */
export const jobLine = (job: Job, now: number): string =>
  LINES[job.status](job, dayOf(lastChange(job), now));

const STATUS_LINES: Readonly<Record<JobStatus, (job: Job, now: number) => string>> = {
  queued: (job, now) => `Waiting · Queued ${ago(job.createdAt, now)}`,
  running: (job, now) => `Running · Started ${ago(job.createdAt, now)}`,
  succeeded: (job, now) => `Done · Finished ${ago(lastChange(job), now)}`,
  failed: (job, now) => `Failed · Stopped ${ago(lastChange(job), now)}`,
  canceled: (job, now) => `Cancelled · Stopped ${ago(lastChange(job), now)}`,
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

  return job.status === "canceled"
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
