import { describe, expect, it } from "vitest";
import { Effect, Layer, Schedule } from "effect";

import * as JobWorker from "./job-worker.ts";
import { MediaBackend } from "./media-backend.ts";
import {
  fixtureLibrary,
  MEDIA_TEST_TIMEOUT,
  temporaryDirectory,
  testConfig,
} from "./testing/fixtures.ts";
import {
  isSettled,
  jobById,
  layerMemory,
  MemoryMediaBackendControl,
} from "./testing/memory-media-backend.ts";
import { runScoped } from "./testing/run.ts";

const untilSettled = (
  control: MemoryMediaBackendControl["Service"],
  jobId: Parameters<typeof jobById>[1],
) =>
  control.jobs.pipe(
    Effect.map((jobs) => jobById(jobs, jobId)),
    Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: isSettled, times: 500 }),
  );

describe("JobWorker", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("claims a pending scan, reports its counts, and finishes it", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const dataDir = yield* temporaryDirectory("data");
        const services = Layer.merge(layerMemory, testConfig(dataDir));

        const context = yield* Layer.build(
          Layer.merge(services, JobWorker.layer.pipe(Layer.provide(services))),
        );

        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
        const libraryId = yield* control.addLibrary(root);
        const jobId = yield* control.enqueueScan(libraryId);
        const job = yield* untilSettled(control, jobId);

        expect(job).toMatchObject({
          status: "done",
          progress: { done: 10, total: 10 },
          outcome: { status: "done", message: "10 files, 10 updated, 0 missing" },
        });

        expect(yield* control.tracks).toHaveLength(10);
      }),
    ));

  it("fails a job whose library folder is missing", () =>
    runScoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory("data");
        const services = Layer.merge(layerMemory, testConfig(dataDir));

        const context = yield* Layer.build(
          Layer.merge(services, JobWorker.layer.pipe(Layer.provide(services))),
        );

        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
        const libraryId = yield* control.addLibrary(`${dataDir}/missing`);
        const job = yield* untilSettled(control, yield* control.enqueueScan(libraryId));

        expect(job?.status).toBe("failed");
        expect(job?.outcome).toEqual({
          status: "failed",
          error: `Library folder unavailable: ${dataDir}/missing`,
        });
      }),
    ));

  it("stops without finishing when the job is cancelled while it runs", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const dataDir = yield* temporaryDirectory("data");
        const memory = yield* Layer.build(layerMemory);
        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(memory));
        const backend = yield* MediaBackend.pipe(Effect.provideContext(memory));

        // Cancels each job right after the worker claims it, as an admin would mid-scan.
        const cancelling = Layer.succeed(
          MediaBackend,
          MediaBackend.of({
            ...backend,
            claimJob: (jobId, workerId) =>
              backend.claimJob(jobId, workerId).pipe(Effect.tap(() => control.cancelJob(jobId))),
          }),
        );

        const services = Layer.merge(cancelling, testConfig(dataDir));
        yield* Layer.build(JobWorker.layer.pipe(Layer.provide(services)));
        const libraryId = yield* control.addLibrary(root);
        const jobId = yield* control.enqueueScan(libraryId);
        const job = yield* untilSettled(control, jobId);

        yield* Effect.sleep("200 millis");
        expect(jobById(yield* control.jobs, jobId)).toMatchObject({
          status: "cancelled",
          outcome: undefined,
        });
        expect(job?.status).toBe("cancelled");
      }),
    ));
});
