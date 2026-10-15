import type { JobId } from "@music/commands/ids";
import type { Job } from "@music/commands/models";
import { Duration, Effect, Ref, Schedule } from "effect";

import type { Api } from "./api";
import { JobError } from "./errors";
import { escapeControlCharacters } from "./escape";
import { Output } from "./output";

/** Polling starts fast for quick jobs and backs off to one request every five seconds. */
const pollSchedule = Schedule.exponential("250 millis", 1.5).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(5))),
  ),
);

const isFinished = (job: Job): boolean =>
  job.status === "done" || job.status === "failed" || job.status === "cancelled";

/** `Scan Music: running 120/500 (reading tags)` */
export const progressLine = (job: Job): string => {
  const count = job.total === null ? String(job.done) : `${String(job.done)}/${String(job.total)}`;
  const note = job.error ?? job.message;
  const detail = note === null ? "" : ` (${escapeControlCharacters(note)})`;

  // The label names a library, and the note can quote a file's name or an error from disk.
  return `${escapeControlCharacters(job.label)}: ${job.status} ${count}${detail}`;
};

/** How `--wait` behaves. */
export interface WaitOptions {
  /** Suppress progress lines on stderr (for `--json`). */
  readonly quiet: boolean;
  readonly timeout: Duration.Duration;
}

/**
 * Polls `jobs.get` until the job is done, failed, or cancelled, printing progress to stderr
 * whenever it changes. Fails unless the job finished successfully.
 */
export const waitForJob = Effect.fn("Jobs.wait")(function* (
  api: Api,
  jobId: JobId,
  options: WaitOptions,
) {
  const output = yield* Output;
  const lastLine = yield* Ref.make("");

  const report = (job: Job): Effect.Effect<void> =>
    Effect.gen(function* () {
      const line = progressLine(job);

      if (options.quiet || (yield* Ref.getAndSet(lastLine, line)) === line) return;

      yield* output.err(line);
    });

  const job = yield* api.read("jobs.get", { jobId }).pipe(
    Effect.tap(report),
    Effect.repeat({ schedule: pollSchedule, until: isFinished }),
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () =>
        Effect.fail(
          new JobError({
            code: "timeout",
            jobId,
            message: `Job ${jobId} is still running after ${Duration.format(options.timeout)}; check it with music jobs get ${jobId}`,
          }),
        ),
    }),
  );

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
