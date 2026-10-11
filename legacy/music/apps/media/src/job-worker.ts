/**
 * Runs scan jobs from Convex. The worker subscribes to pending jobs, claims one at a time,
 * renews its lease while the scan runs, stops when the job is cancelled, and reports the result.
 * Claims are guarded by Convex and scans are idempotent, so a job that runs twice is harmless.
 */
import { hostname } from "node:os";

import type { JobId } from "@music/commands/ids";
import { Cause, Data, Effect, Layer, Option, Ref, Schedule, Stream } from "effect";

import {
  type JobOutcome,
  type JobProgress,
  MediaBackend,
  resubscribeSchedule,
} from "./media-backend.ts";
import type { MediaConfig } from "./media-config.ts";
import { describeScan, scanLibrary, type ScanSummary } from "./scan.ts";

/** How often a running job reports progress; well inside the 60 second lease. */
const HEARTBEAT = "5 seconds";

type JobEnd = Data.TaggedEnum<{
  Finished: { readonly summary: ScanSummary };
  Failed: { readonly error: string };
  Cancelled: {};
}>;

const JobEnd = Data.taggedEnum<JobEnd>();

const outcomeOf = (end: JobEnd): JobOutcome | undefined =>
  JobEnd.$match(end, {
    Finished: ({ summary }): JobOutcome => ({ status: "done", message: describeScan(summary) }),
    Failed: ({ error }): JobOutcome => ({ status: "failed", error }),
    Cancelled: () => undefined,
  });

const runJob = Effect.fn("JobWorker.runJob")(
  function* (jobId: JobId, workerId: string) {
    const backend = yield* MediaBackend;
    const claimed = yield* backend.claimJob(jobId, workerId);

    if (Option.isNone(claimed)) return;
    const { library } = claimed.value;
    const progress = yield* Ref.make<JobProgress>({ done: 0 });

    yield* Effect.logInfo("JobWorker.started");

    const scan = scanLibrary(library, progress).pipe(
      Effect.map((summary) => JobEnd.Finished({ summary })),
      Effect.catchTags({
        LibraryUnavailable: (error) => Effect.succeed(JobEnd.Failed({ error: error.message })),
        BackendError: (error) => Effect.succeed(JobEnd.Failed({ error: error.message })),
      }),
      // A defect in one scan must not stop the worker; record it on the job instead.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logError("JobWorker.scan_defect", cause).pipe(
            Effect.as(JobEnd.Failed({ error: "The scan stopped on an internal error" })),
          ),
      ),
    );

    const reportOnce = Ref.get(progress).pipe(
      Effect.flatMap((current) => backend.reportJob(jobId, workerId, current)),
      Effect.catchTag("BackendError", (error) =>
        Effect.logWarning("JobWorker.report_failed", error).pipe(Effect.as(false)),
      ),
    );

    const untilCancelled = reportOnce.pipe(
      Effect.repeat({ schedule: Schedule.spaced(HEARTBEAT), until: (cancelled) => cancelled }),
      Effect.as(JobEnd.Cancelled()),
    );

    const end = yield* Effect.raceFirst(scan, untilCancelled);
    const outcome = outcomeOf(end);

    if (outcome === undefined) {
      yield* Effect.logInfo("JobWorker.cancelled");

      return;
    }

    // The last heartbeat may predate the end of the scan; leave the final counts on the job.
    yield* reportOnce;
    yield* backend.finishJob(jobId, workerId, outcome);
    yield* Effect.logInfo("JobWorker.finished").pipe(Effect.annotateLogs({ outcome }));
  },
  (effect, jobId) => effect.pipe(Effect.annotateLogs({ jobId })),
);

/** Processes pending jobs for the lifetime of the layer. */
export const layer: Layer.Layer<never, never, MediaBackend | MediaConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend;
    const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;

    yield* backend.pendingJobs.pipe(
      Stream.runForEach((jobs) =>
        Effect.forEach(
          jobs,
          (job) =>
            runJob(job.jobId, workerId).pipe(
              Effect.catchTag("BackendError", (error) =>
                Effect.logWarning("JobWorker.job_failed", error),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.tapError((error) => Effect.logWarning("JobWorker.subscription_lost", error)),
      Effect.retry(resubscribeSchedule),
      Effect.annotateLogs({ workerId }),
      Effect.forkScoped,
    );

    yield* Effect.logInfo("JobWorker.ready").pipe(Effect.annotateLogs({ workerId }));
  }),
);
