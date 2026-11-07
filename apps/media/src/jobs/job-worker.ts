import { hostname } from "node:os";

import type { JobId } from "@media/contracts/ids";
import type { Job, JobKind, JobProgress } from "@media/contracts/models/jobs";
import type { ClaimedJob } from "@media/contracts/models/scan";
import {
  Cause,
  Crypto,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";

import * as MediaBackend from "../convex/media-backend.ts";

/** A handler's expected failure, recorded on the job. */
export class JobFailed extends Schema.TaggedError<JobFailed>()("JobFailed", {
  /** Shown to admins on the job; no paths outside the library or secrets. */
  message: Schema.String,
  /** Return the job to the queue (up to five attempts in all) instead of failing it for good. */
  retry: Schema.Boolean,
}) {}

type JobDomain = "movies" | "server";

type JobPool = JobDomain | `${Exclude<JobDomain, "server">}.background`;

const jobPools = {
  scan: "movies",
  metadata: "movies",
  person: "movies",
  migration: "movies",
  trickplay: "movies.background",
  backup: "server",
} as const satisfies Record<JobKind, JobPool>;

type PoolName = (typeof jobPools)[JobKind];

/**
 * The most jobs each pool runs at once; each a whole number of at least 1. A job whose pool is
 * full waits, and never takes another pool's slot.
 */
export type PoolCaps = { readonly [Pool in PoolName]: number };

/** Runs the jobs of one kind. */
export interface JobHandler {
  readonly kind: JobKind;
  /**
   * Runs a claimed job and returns the message recorded when it succeeds. `workerId` holds the
   * lease, for functions that require it; `reportProgress` replaces what the next lease renewal
   * reports.
   */
  readonly run: (
    claim: ClaimedJob,
    workerId: string,
    reportProgress: (progress: JobProgress) => Effect.Effect<void>,
  ) => Effect.Effect<string, JobFailed>;
}

type JobEnd = Data.TaggedEnum<{
  Finished: { readonly message: string };
  Failed: { readonly error: JobFailed };
  Cancelled: {};
  LeaseLost: {};
}>;

const JobEnd = Data.taggedEnum<JobEnd>();

const LEASE_MS = 60_000;

const RENEW_EVERY = Duration.seconds(15);

const RESCAN_EVERY = Duration.seconds(30);

const EMPTY_PROGRESS: JobProgress = { done: 0, total: null, message: null };

const make = Effect.fn("JobWorker.make")(function* ({
  handlers,
  caps,
}: {
  readonly handlers: ReadonlyArray<JobHandler>;
  readonly caps: PoolCaps;
}) {
  const backend = yield* MediaBackend.Service;
  const crypto = yield* Crypto.Crypto;
  const suffix = Buffer.from(yield* crypto.randomBytes(6).pipe(Effect.orDie)).toString("hex");
  const workerId = `${hostname()}:${String(process.pid)}:${suffix}`;
  const byKind = new Map(handlers.map((handler) => [handler.kind, handler]));
  const pending = yield* Ref.make<ReadonlyArray<Job>>([]);
  const running = yield* Ref.make<ReadonlyMap<JobId, PoolName>>(new Map());

  const wake = yield* Queue.sliding<void>(1);

  const keepLease = (jobId: JobId, progress: Ref.Ref<JobProgress>): Effect.Effect<JobEnd> =>
    Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(RENEW_EVERY);

        const renewed = yield* backend
          .call("mediaService.renewLease", {
            jobId,
            workerId,
            leaseMs: LEASE_MS,
            progress: yield* Ref.get(progress),
          })
          .pipe(
            Effect.map((result): Option.Option<JobEnd> =>
              result.cancelled ? Option.some(JobEnd.Cancelled()) : Option.none(),
            ),
            Effect.catchTags({
              Conflict: () => Effect.succeedSome<JobEnd>(JobEnd.LeaseLost()),
              NotFound: () => Effect.succeedSome<JobEnd>(JobEnd.LeaseLost()),
            }),
            Effect.catch((error) =>
              Effect.logWarning("JobWorker.renew_failed", error).pipe(
                Effect.as(Option.none<JobEnd>()),
              ),
            ),
          );

        if (Option.isSome(renewed)) return renewed.value;
      }
    });

  const settle = Effect.fn("JobWorker.settle")(function* (jobId: JobId, end: JobEnd) {
    const write = JobEnd.$match(end, {
      Finished: ({ message }) =>
        backend.call("mediaService.completeJob", { jobId, workerId, message }),
      Failed: ({ error }) =>
        backend.call("mediaService.failJob", {
          jobId,
          workerId,
          error: error.message,
          retry: error.retry,
        }),
      Cancelled: () => Effect.succeed({ ok: true as const }),
      LeaseLost: () => Effect.succeed({ ok: true as const }),
    });

    yield* write.pipe(
      Effect.retry({
        while: (error) => Predicate.isTagged(error, "TransportError"),
        schedule: Schedule.exponential("500 millis").pipe(Schedule.upTo({ times: 5 })),
      }),
      Effect.catch((error) => Effect.logWarning("JobWorker.settle_failed", error)),
    );

    yield* Effect.logInfo("JobWorker.job_ended").pipe(
      Effect.annotateLogs({
        outcome: JobEnd.$match(end, {
          Finished: () => "succeeded",
          Failed: ({ error }) => (error.retry ? "retrying" : "failed"),
          Cancelled: () => "cancelled",
          LeaseLost: () => "lease-lost",
        }),
      }),
    );
  });

  const runJob = Effect.fn("JobWorker.runJob")(
    function* (job: Job, handler: JobHandler) {
      const claimed = yield* backend
        .call("mediaService.claimJob", { jobId: job.id, workerId, leaseMs: LEASE_MS })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("JobWorker.claim_failed", error).pipe(Effect.as(null)),
          ),
        );

      if (claimed === null) return;
      yield* Effect.logInfo("JobWorker.claimed").pipe(Effect.annotateLogs({ kind: job.kind }));
      const progress = yield* Ref.make(EMPTY_PROGRESS);

      const work = handler
        .run(claimed, workerId, (next) => Ref.set(progress, next))
        .pipe(
          Effect.map((message) => JobEnd.Finished({ message })),
          Effect.catchTag("JobFailed", (error) => Effect.succeed(JobEnd.Failed({ error }))),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("JobWorker.handler_defect", cause).pipe(
                Effect.as(
                  JobEnd.Failed({
                    error: new JobFailed({
                      message: "The job stopped on an internal error",
                      retry: false,
                    }),
                  }),
                ),
              ),
          ),
        );

      const end = yield* Effect.raceFirst(work, keepLease(job.id, progress));

      if (JobEnd.$is("Finished")(end) || JobEnd.$is("Failed")(end)) {
        yield* backend
          .call("mediaService.renewLease", {
            jobId: job.id,
            workerId,
            leaseMs: LEASE_MS,
            progress: yield* Ref.get(progress),
          })
          .pipe(Effect.ignore);
      }

      yield* settle(job.id, end);
    },
    (effect, job) => effect.pipe(Effect.annotateLogs({ jobId: job.id, workerId })),
  );

  const dispatch = Effect.gen(function* () {
    for (const job of yield* Ref.get(pending)) {
      const handler = byKind.get(job.kind);

      if (handler === undefined) continue;
      const pool = jobPools[job.kind];

      const start = yield* Ref.modify(running, (current) => {
        const inPool = [...current.values()].filter((held) => held === pool).length;

        return current.has(job.id) || inPool >= caps[pool]
          ? [false, current]
          : [true, new Map(current).set(job.id, pool)];
      });

      if (!start) continue;

      yield* runJob(job, handler).pipe(
        Effect.ensuring(
          Ref.update(running, (current) => {
            const next = new Map(current);
            next.delete(job.id);

            return next;
          }).pipe(Effect.andThen(Queue.offer(wake, undefined))),
        ),
        Effect.forkScoped,
      );
    }
  });

  yield* backend.subscribe("mediaService.pendingJobs", {}).pipe(
    Stream.runForEach((jobs) =>
      Ref.set(pending, jobs).pipe(Effect.andThen(Queue.offer(wake, undefined))),
    ),
    Effect.forkScoped,
  );

  yield* Queue.offer(wake, undefined).pipe(
    Effect.repeat(Schedule.spaced(RESCAN_EVERY)),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(wake).pipe(
    Stream.runForEach(() => dispatch),
    Effect.forkScoped,
  );
  yield* Effect.logInfo("JobWorker.ready").pipe(Effect.annotateLogs({ workerId }));
});

/** Runs jobs with `handlers` for the lifetime of the layer, each pool capped by `caps`. */
export const layer = <R>(
  setup: Effect.Effect<
    { readonly handlers: ReadonlyArray<JobHandler>; readonly caps: PoolCaps },
    never,
    R
  >,
): Layer.Layer<never, never, R | MediaBackend.Service | Crypto.Crypto> =>
  Layer.effectDiscard(Effect.flatMap(setup, make));
