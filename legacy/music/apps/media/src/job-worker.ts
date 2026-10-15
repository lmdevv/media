/**
 * Runs scan jobs from Convex. The worker subscribes to pending jobs, claims one at a time,
 * renews its lease while the scan runs, stops when the job is cancelled, and reports the result.
 * Claims are guarded by Convex and scans are idempotent, so a job that runs twice is harmless.
 *
 * It also deletes the artwork nothing uses any more: at startup, after a scan that changed
 * songs, and a while after a library is deleted (Convex purges its songs in the background).
 * Collections and jobs take turns, so no scan of this worker is storing artwork meanwhile.
 */
import { hostname } from "node:os";

import type { JobId } from "@music/commands/ids";
import { Cause, Data, Effect, Layer, Option, Ref, Schedule, Semaphore, Stream } from "effect";

import { collectUnusedArt } from "./art-collector.ts";
import {
  type JobOutcome,
  type JobProgress,
  MediaBackend,
  resubscribeSchedule,
} from "./media-backend.ts";
import type { MediaConfig } from "./media-config.ts";
import { claimRoot } from "./root-claim.ts";
import { describeScan, LibraryUnavailable, scanLibrary, type ScanSummary } from "./scan.ts";

/** How often a running job reports progress; well inside the 60 second lease. */
const HEARTBEAT = "5 seconds";

/**
 * How long after a library is deleted its artwork is collected: Convex purges the library's
 * songs in batches meanwhile. Art a slower purge leaves goes at a later collection.
 */
const PURGE_WAIT = "5 minutes";

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

const changedSongs = (summary: ScanSummary): boolean =>
  summary.updated + summary.moved + summary.missing > 0;

const runJob = Effect.fn("JobWorker.runJob")(
  function* (jobId: JobId, workerId: string) {
    const backend = yield* MediaBackend;
    const claimed = yield* backend.claimJob(jobId, workerId);

    if (Option.isNone(claimed)) return;
    const { library } = claimed.value;
    const progress = yield* Ref.make<JobProgress>({ done: 0 });

    yield* Effect.logInfo("JobWorker.started");

    // The scan reads the real folder Convex accepted, not the path the library was added with.
    const scan = claimRoot(library).pipe(
      Effect.catchTag("FileError", (cause) =>
        Effect.fail(new LibraryUnavailable({ libraryId: library.id, path: library.path, cause })),
      ),
      Effect.flatMap((realPath) => scanLibrary({ ...library, path: realPath }, progress)),
      Effect.map((summary) => JobEnd.Finished({ summary })),
      Effect.catchTags({
        LibraryUnavailable: (error) => Effect.succeed(JobEnd.Failed({ error: error.message })),
        LibraryEmpty: (error) => Effect.succeed(JobEnd.Failed({ error: error.message })),
        RootRefused: (error) => Effect.succeed(JobEnd.Failed({ error: error.message })),
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

    // Artwork only falls out of use when songs change.
    if (JobEnd.$is("Finished")(end) && changedSongs(end.summary)) {
      yield* collectUnusedArt().pipe(
        Effect.catchTags({
          BackendError: (error) => Effect.logWarning("JobWorker.art_collection_failed", error),
          FileError: (error) => Effect.logWarning("JobWorker.art_collection_failed", error),
        }),
      );
    }
  },
  (effect, jobId) => effect.pipe(Effect.annotateLogs({ jobId })),
);

/** Processes pending jobs for the lifetime of the layer. */
export const layer: Layer.Layer<never, never, MediaBackend | MediaConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend;
    const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
    // Jobs and collections take turns: a scan stores artwork before it stores the songs using it.
    const turns = yield* Semaphore.make(1);

    const collect = turns.withPermits(1)(
      collectUnusedArt().pipe(
        Effect.catchTags({
          BackendError: (error) => Effect.logWarning("JobWorker.art_collection_failed", error),
          FileError: (error) => Effect.logWarning("JobWorker.art_collection_failed", error),
        }),
      ),
    );

    const collectAfterDeletions = backend.libraries.pipe(
      Stream.mapAccum(
        (): ReadonlySet<string> | null => null,
        (previous, libraries) => {
          const ids: ReadonlySet<string> = new Set(libraries.map((library) => library.id));
          const deleted = previous !== null && [...previous].some((id) => !ids.has(id));

          return [ids, deleted ? [undefined] : []] as const;
        },
      ),
      Stream.debounce(PURGE_WAIT),
      Stream.runForEach(() => collect),
      Effect.tapError((error) => Effect.logWarning("JobWorker.subscription_lost", error)),
      Effect.retry(resubscribeSchedule),
    );

    const runJobs = backend.pendingJobs.pipe(
      Stream.runForEach((jobs) =>
        Effect.forEach(
          jobs,
          (job) =>
            turns
              .withPermits(1)(runJob(job.jobId, workerId))
              .pipe(
                Effect.catchTag("BackendError", (error) =>
                  Effect.logWarning("JobWorker.job_failed", error),
                ),
              ),
          { discard: true },
        ),
      ),
      Effect.tapError((error) => Effect.logWarning("JobWorker.subscription_lost", error)),
      Effect.retry(resubscribeSchedule),
    );

    // Artwork that went out of use while the service was down (a deleted library) goes first.
    yield* collect.pipe(
      Effect.andThen(runJobs),
      Effect.annotateLogs({ workerId }),
      Effect.forkScoped,
    );

    yield* collectAfterDeletions.pipe(Effect.annotateLogs({ workerId }), Effect.forkScoped);

    yield* Effect.logInfo("JobWorker.ready").pipe(Effect.annotateLogs({ workerId }));
  }),
);
