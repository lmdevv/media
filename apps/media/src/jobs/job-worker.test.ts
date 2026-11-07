import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Layer, Queue, Ref, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import { Conflict } from "@media/contracts/errors";
import { JobId, LibraryId, MediaFileId } from "@media/contracts/ids";
import type { Job, JobPayload, JobProgress } from "@media/contracts/models/jobs";
import { EpochMillis } from "@media/contracts/units";
import { type CallError, TransportError } from "@media/sdk/effect";

import * as MemoryBackend from "../testing/memory-backend.ts";
import * as JobWorker from "./job-worker.ts";

const job: Job = {
  id: JobId.make("job_1"),
  kind: "scan",
  status: "pending",
  payload: { kind: "scan", libraryId: LibraryId.make("library_1"), mode: "quick" },
  progress: { done: 0, total: null, message: null },
  error: null,
  requestedBy: null,
  attempts: 0,
  createdAt: EpochMillis.make(0),
  startedAt: null,
  finishedAt: null,
};

const caps: JobWorker.PoolCaps = { movies: 2, "movies.background": 1, server: 1 };

type Write =
  | { readonly name: "claim" }
  | { readonly name: "renew"; readonly progress: JobProgress | undefined }
  | { readonly name: "complete"; readonly message: string | undefined }
  | { readonly name: "fail"; readonly error: string; readonly retry: boolean };

type Renewal = (count: number) => Effect.Effect<{ readonly cancelled: boolean }, CallError>;

const stillHeld: Renewal = () => Effect.succeed({ cancelled: false });

const startWorker = Effect.fnUntraced(function* (
  run: JobWorker.JobHandler["run"],
  renewal: Renewal = stillHeld,
) {
  const writes = yield* Ref.make<ReadonlyArray<Write>>([]);
  const renewals = yield* Ref.make(0);
  const claimed = yield* Ref.make(false);
  const record = (write: Write) => Ref.update(writes, (seen) => [...seen, write]);
  const ok = { ok: true as const };

  const backend = MemoryBackend.layer(
    {
      "mediaService.claimJob": () =>
        Ref.getAndSet(claimed, true).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.succeed(null)
              : record({ name: "claim" }).pipe(
                  Effect.as({ job, library: null, leaseExpiresAt: EpochMillis.make(60_000) }),
                ),
          ),
        ),
      "mediaService.renewLease": ({ progress }) =>
        record({ name: "renew", progress }).pipe(
          Effect.andThen(Ref.getAndUpdate(renewals, (count) => count + 1)),
          Effect.flatMap(renewal),
          Effect.map(({ cancelled }) => ({ cancelled, leaseExpiresAt: EpochMillis.make(0) })),
        ),
      "mediaService.completeJob": ({ message }) =>
        record({ name: "complete", message }).pipe(Effect.as(ok)),
      "mediaService.failJob": ({ error, retry }) =>
        record({ name: "fail", error, retry }).pipe(Effect.as(ok)),
    },
    { "mediaService.pendingJobs": () => Stream.concat(Stream.make([job]), Stream.never) },
  );

  yield* Layer.build(
    JobWorker.layer(
      Effect.succeed({ handlers: [{ kind: "scan", run } satisfies JobWorker.JobHandler], caps }),
    ).pipe(Layer.provide(backend), Layer.provide(NodeServices.layer)),
  );

  return { writes: Ref.get(writes) };
});

const pendingJob = (id: string, payload: JobPayload): Job => ({
  id: JobId.make(id),
  kind: payload.kind,
  status: "pending",
  payload,
  progress: { done: 0, total: null, message: null },
  error: null,
  requestedBy: null,
  attempts: 0,
  createdAt: EpochMillis.make(0),
  startedAt: null,
  finishedAt: null,
});

const thumbnails = (fileId: string): JobPayload => ({
  kind: "trickplay",
  fileId: MediaFileId.make(fileId),
});

const startPools = Effect.fnUntraced(function* (jobs: ReadonlyArray<Job>) {
  const pending = yield* SubscriptionRef.make(jobs);
  const started = yield* Queue.unbounded<string>();

  const finish = new Map(
    yield* Effect.forEach(jobs, (queued) =>
      Deferred.make<string>().pipe(Effect.map((done) => [queued.id, done] as const)),
    ),
  );

  const ok = { ok: true as const };

  const finisher = (id: JobId) => {
    const done = finish.get(id);

    return done === undefined ? Effect.die(`No job ${id}`) : Effect.succeed(done);
  };

  const run: JobWorker.JobHandler["run"] = ({ job: claim }) =>
    Queue.offer(started, claim.id).pipe(
      Effect.andThen(finisher(claim.id)),
      Effect.flatMap(Deferred.await),
    );

  const backend = MemoryBackend.layer(
    {
      "mediaService.claimJob": ({ jobId }) =>
        SubscriptionRef.modify(pending, (queued) => {
          const claim = queued.find((candidate) => candidate.id === jobId);

          return claim === undefined
            ? [null, queued]
            : [
                { job: claim, library: null, leaseExpiresAt: EpochMillis.make(60_000) },
                queued.filter((candidate) => candidate !== claim),
              ];
        }),
      "mediaService.renewLease": () =>
        Effect.succeed({ cancelled: false, leaseExpiresAt: EpochMillis.make(0) }),
      "mediaService.completeJob": () => Effect.succeed(ok),
    },
    { "mediaService.pendingJobs": () => SubscriptionRef.changes(pending) },
  );

  const handlers = [...new Set(jobs.map((queued) => queued.kind))].map(
    (kind): JobWorker.JobHandler => ({ kind, run }),
  );

  yield* Layer.build(
    JobWorker.layer(Effect.succeed({ handlers, caps })).pipe(
      Layer.provide(backend),
      Layer.provide(NodeServices.layer),
    ),
  );

  return {
    nextStarted: (count: number) =>
      Effect.replicateEffect(Queue.take(started), count).pipe(Effect.map((ids) => new Set(ids))),
    unseen: Queue.clear(started),
    finish: (id: string) =>
      finisher(JobId.make(id)).pipe(Effect.flatMap((done) => Deferred.succeed(done, "done"))),
  };
});

const advance = (duration: Duration.Input) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* TestClock.adjust(duration);
    yield* Effect.yieldNow;
  });

describe("job worker", () => {
  it.effect("renews the lease with the handler's progress and completes the job", () =>
    Effect.gen(function* () {
      const { writes } = yield* startWorker((_claim, _worker, reportProgress) =>
        Effect.gen(function* () {
          yield* reportProgress({ done: 3, total: 10, message: "scanning" });
          yield* Effect.sleep(Duration.seconds(20));
          yield* reportProgress({ done: 10, total: 10, message: null });

          return "10 files";
        }),
      );

      yield* advance(Duration.seconds(16));

      assert.deepStrictEqual(yield* writes, [
        { name: "claim" },
        { name: "renew", progress: { done: 3, total: 10, message: "scanning" } },
      ]);

      yield* advance(Duration.seconds(5));

      assert.deepStrictEqual((yield* writes).slice(2), [
        { name: "renew", progress: { done: 10, total: 10, message: null } },
        { name: "complete", message: "10 files" },
      ]);
    }),
  );

  it.effect("stops the handler when a renewal reports the job cancelled", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();

      const { writes } = yield* startWorker(
        () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        (count) => Effect.succeed({ cancelled: count >= 1 }),
      );

      yield* advance(Duration.seconds(16));

      assert.isFalse(yield* Deferred.isDone(interrupted));
      yield* advance(Duration.seconds(15));

      assert.isTrue(yield* Deferred.isDone(interrupted));
      assert.deepStrictEqual(
        (yield* writes).map((write) => write.name),
        ["claim", "renew", "renew"],
      );
    }),
  );

  it.effect("stops the handler and writes nothing more when another worker took the lease", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();

      const { writes } = yield* startWorker(
        () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        () => Effect.fail(new Conflict({ message: "Lease held by another worker" })),
      );

      yield* advance(Duration.seconds(16));
      yield* advance(Duration.minutes(5));

      assert.isTrue(yield* Deferred.isDone(interrupted));
      assert.deepStrictEqual(
        (yield* writes).map((write) => write.name),
        ["claim", "renew"],
      );
    }),
  );

  it.effect("keeps the lease through a renewal that fails in transit", () =>
    Effect.gen(function* () {
      const { writes } = yield* startWorker(
        () => Effect.sleep(Duration.seconds(40)).pipe(Effect.as("done")),
        (count) =>
          count === 0
            ? Effect.fail(
                new TransportError({
                  operation: "mediaService.renewLease",
                  message: "Transport failed: connection reset",
                  cause: null,
                }),
              )
            : Effect.succeed({ cancelled: false }),
      );

      yield* advance(Duration.seconds(41));

      assert.deepStrictEqual(
        (yield* writes).map((write) => write.name),
        ["claim", "renew", "renew", "renew", "complete"],
      );
    }),
  );

  it.effect("records expected failures with their retry flag and defects without one", () =>
    Effect.gen(function* () {
      const { writes: retried } = yield* startWorker(() =>
        Effect.fail(new JobWorker.JobFailed({ message: "Library folder unreadable", retry: true })),
      );

      yield* advance(Duration.millis(1));

      assert.deepStrictEqual((yield* retried).at(-1), {
        name: "fail",
        error: "Library folder unreadable",
        retry: true,
      });

      const { writes: crashed } = yield* startWorker(() => Effect.die("boom"));

      yield* advance(Duration.millis(1));

      assert.deepStrictEqual((yield* crashed).at(-1), {
        name: "fail",
        error: "The job stopped on an internal error",
        retry: false,
      });
    }),
  );

  it.effect("holds a job whose pool is full while another pool's job starts", () =>
    Effect.gen(function* () {
      const { nextStarted, unseen, finish } = yield* startPools([
        pendingJob("scan_1", job.payload),
        pendingJob("scan_2", job.payload),
        pendingJob("scan_3", job.payload),
        pendingJob("backup_1", { kind: "backup", trigger: "nightly" }),
        pendingJob("backup_2", { kind: "backup", trigger: "manual" }),
      ]);

      assert.deepStrictEqual(yield* nextStarted(3), new Set(["scan_1", "scan_2", "backup_1"]));

      yield* finish("backup_1");

      assert.deepStrictEqual(yield* nextStarted(1), new Set(["backup_2"]));
      assert.deepStrictEqual(yield* unseen, []);

      yield* finish("scan_1");

      assert.deepStrictEqual(yield* nextStarted(1), new Set(["scan_3"]));
    }),
  );

  it.effect("runs scrub thumbnails in their own pool, so they never hold up a scan", () =>
    Effect.gen(function* () {
      const { nextStarted, unseen } = yield* startPools([
        pendingJob("trickplay_1", thumbnails("file_1")),
        pendingJob("trickplay_2", thumbnails("file_2")),
        pendingJob("scan_1", job.payload),
      ]);

      assert.deepStrictEqual(yield* nextStarted(2), new Set(["trickplay_1", "scan_1"]));
      assert.deepStrictEqual(yield* unseen, []);
    }),
  );
});
