import type { JobId } from "@media/contracts/ids";
import type { Job } from "@media/contracts/models/jobs";
import type { MoviesClient } from "@media/sdk/effect";
import { Clock, Duration, Effect, Option, Ref, Stream } from "effect";

import { JobError } from "./cli-errors";
import { Output } from "./output";

const isFinished = (job: Job): boolean =>
  job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";

/** `scan <job-id>: running 120/500 (reading tags)`; the ID tells jobs followed together apart. */
export const progressLine = (job: Job): string => {
  const { done, total, message } = job.progress;
  const count = total === null ? String(done) : `${String(done)}/${String(total)}`;
  const note = job.error ?? message;

  return `${job.kind} ${job.id}: ${job.status} ${count}${note === null ? "" : ` (${note})`}`;
};

const MAX_POLLERS = 4;

/** How `--wait` behaves. */
export interface WaitOptions {
  /** Print progress lines on stderr when the job changes. */
  readonly progress: boolean;
  readonly timeout: Duration.Duration;
}

const followJob = Effect.fn("Jobs.follow")(function* (
  client: MoviesClient.Interface,
  jobId: JobId,
  options: WaitOptions,
  deadlineMs: number,
) {
  const output = yield* Output;
  const remaining = Duration.millis(Math.max(0, deadlineMs - (yield* Clock.currentTimeMillis)));
  const lastLine = yield* Ref.make("");

  const report = (job: Job): Effect.Effect<void> =>
    Effect.gen(function* () {
      const line = progressLine(job);

      if (!options.progress || (yield* Ref.getAndSet(lastLine, line)) === line) return;

      yield* output.err(line);
    });

  const finished = yield* client
    .subscribe("jobs.get", { jobId })
    .pipe(
      Stream.tap(report),
      Stream.filter(isFinished),
      Stream.runHead,
      Effect.timeoutOption(remaining),
      Effect.map(Option.flatten),
    );

  if (Option.isNone(finished)) {
    return yield* new JobError({
      code: "timeout",
      jobId,
      message: `Job ${jobId} is still running after ${Duration.format(options.timeout)}; check it with media jobs get ${jobId}`,
    });
  }

  const job = finished.value;

  if (job.status === "failed") {
    return yield* new JobError({
      code: "job_failed",
      jobId,
      message: `Job ${jobId} failed: ${job.error ?? "no error reported"}`,
    });
  }

  if (job.status === "cancelled") {
    return yield* new JobError({
      code: "job_cancelled",
      jobId,
      message: `Job ${jobId} was cancelled`,
    });
  }

  return job;
});

/**
 * Watches `jobs.get` until the job succeeds, fails, or is cancelled, printing progress to stderr
 * whenever it changes. Fails unless the job succeeded within `options.timeout`.
 */
export const waitForJob = Effect.fn("Jobs.wait")(function* (
  client: MoviesClient.Interface,
  jobId: JobId,
  options: WaitOptions,
) {
  const now = yield* Clock.currentTimeMillis;

  return yield* followJob(client, jobId, options, now + Duration.toMillis(options.timeout));
});

/**
 * Follows several jobs until each succeeds, at most four at a time; `options.timeout` bounds the
 * whole wait, including jobs that wait for a free poller. Fails with the first job that fails, is
 * cancelled, or is still running when the time is up.
 */
export const waitForJobs = Effect.fn("Jobs.waitAll")(function* (
  client: MoviesClient.Interface,
  jobIds: ReadonlyArray<JobId>,
  options: WaitOptions,
) {
  const deadlineMs = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.timeout);

  return yield* Effect.forEach(jobIds, (jobId) => followJob(client, jobId, options, deadlineMs), {
    concurrency: MAX_POLLERS,
  });
});
