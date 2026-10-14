import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Clock, Effect, Layer, Schedule } from "effect";
import { TestClock } from "effect/testing";

import * as Files from "./files.ts";
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
import { setFileTime } from "./testing/file-times.ts";
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

  it("fails a job whose library folder is empty, keeping its songs", () =>
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

        yield* untilSettled(control, yield* control.enqueueScan(libraryId));

        for (const name of yield* Files.listNames(root)) yield* Files.removePath(join(root, name));
        const job = yield* untilSettled(control, yield* control.enqueueScan(libraryId));

        expect(job?.outcome).toEqual({
          status: "failed",
          error: `The folder is empty. Is the drive mounted? (${root}) If its music was removed on purpose, delete the library.`,
        });
        expect((yield* control.tracks).filter((track) => track.missing)).toEqual([]);
      }),
    ));

  it("deletes the artwork nothing uses once a scan changed songs", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const dataDir = yield* temporaryDirectory("data");
        const art = join(dataDir, "art");
        const services = Layer.merge(layerMemory, testConfig(dataDir));

        const context = yield* Layer.build(
          Layer.merge(services, JobWorker.layer.pipe(Layer.provide(services))),
        );

        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
        const libraryId = yield* control.addLibrary(root);

        yield* untilSettled(control, yield* control.enqueueScan(libraryId));
        const before = yield* Files.listNames(art);
        const cover = join(root, "The Sine Waves/Folder Art/cover.jpg");

        const oldCover = createHash("sha256")
          .update(yield* Files.readWholeFile(cover))
          .digest("hex");

        // An hour later, the album's cover is replaced.
        for (const name of before) {
          yield* Effect.promise(() => setFileTime(join(art, name), Date.now() - 60 * 60 * 1000));
        }

        const replaced = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]);

        yield* Files.writeFileAtomic(cover, replaced, "x");
        yield* untilSettled(control, yield* control.enqueueScan(libraryId));

        const after = yield* Files.listNames(art).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("20 millis"),
            until: (names) => !names.includes(oldCover),
            times: 100,
          }),
        );

        expect(before).toContain(oldCover);
        expect(after.toSorted()).toEqual(
          [
            ...before.filter((name) => name !== oldCover),
            createHash("sha256").update(replaced).digest("hex"),
          ].toSorted(),
        );
      }),
    ));

  it("deletes artwork that went out of use while it was stopped when it starts", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const dataDir = yield* temporaryDirectory("data");
        const services = yield* Layer.build(Layer.merge(layerMemory, testConfig(dataDir)));
        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(services));
        const worker = JobWorker.layer.pipe(Layer.provide(Layer.succeedContext(services)));

        // A first run scans the library.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(worker);
            yield* untilSettled(
              control,
              yield* control.enqueueScan(yield* control.addLibrary(root)),
            );
          }),
        );

        // Meanwhile a library was deleted: its art stays behind, unused for an hour.
        const orphan = join(dataDir, "art", "0".repeat(64));

        yield* Files.writeFileAtomic(orphan, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "w");
        yield* Effect.promise(() => setFileTime(orphan, Date.now() - 60 * 60 * 1000));

        const kept = (yield* Files.listNames(join(dataDir, "art"))).filter(
          (name) => name !== "0".repeat(64),
        );

        yield* Layer.build(worker);

        const after = yield* Files.listNames(join(dataDir, "art")).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("20 millis"),
            until: (names) => !names.includes("0".repeat(64)),
            times: 100,
          }),
        );

        expect(after.toSorted()).toEqual(kept.toSorted());
      }),
    ));

  it("deletes a deleted library's artwork once Convex has had time to purge it", () =>
    runScoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        const { root } = yield* fixtureLibrary;

        // Stored artwork carries real file times, which the collector compares with the clock.
        yield* clock.setTime(Date.now());
        const other = yield* temporaryDirectory("other");
        const dataDir = yield* temporaryDirectory("data");
        const art = join(dataDir, "art");
        const services = Layer.merge(layerMemory, testConfig(dataDir));

        // A second library keeps a cover of its own in use.
        yield* Files.copyTree(
          join(root, "The Sine Waves/Folder Art/01 Brushes.m4a"),
          join(other, "song.m4a"),
        );
        yield* Files.writeFileAtomic(
          join(other, "cover.jpg"),
          new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]),
          "w",
        );

        yield* Effect.gen(function* () {
          const context = yield* Layer.build(
            Layer.merge(services, JobWorker.layer.pipe(Layer.provide(services))),
          );

          const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));

          const settled = (jobId: Parameters<typeof jobById>[1]) =>
            clock.withLive(untilSettled(control, jobId));

          const deleted = yield* control.addLibrary(root);

          yield* settled(yield* control.enqueueScan(deleted));
          yield* settled(yield* control.enqueueScan(yield* control.addLibrary(other)));

          const kept = (yield* control.tracks)
            .filter((track) => track.libraryId !== deleted)
            .flatMap((track) => track.scanned.artHash ?? []);

          for (const name of yield* Files.listNames(art)) {
            yield* Effect.promise(() => setFileTime(join(art, name), Date.now() - 60 * 60 * 1000));
          }

          // Adding a library collects nothing, not even art no song uses: only a deletion does.
          const orphan = join(art, "0".repeat(64));

          yield* Files.writeFileAtomic(orphan, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "w");
          yield* Effect.promise(() => setFileTime(orphan, Date.now() - 60 * 60 * 1000));

          const before = yield* Files.listNames(art);

          yield* control.addLibrary(yield* temporaryDirectory("added"));
          yield* clock.withLive(Effect.sleep("100 millis"));
          yield* clock.adjust("5 minutes");
          yield* clock.withLive(Effect.sleep("300 millis"));
          expect((yield* Files.listNames(art)).toSorted()).toEqual(before.toSorted());

          yield* control.deleteLibrary(deleted);
          yield* clock.withLive(Effect.sleep("100 millis"));
          expect((yield* Files.listNames(art)).length).toBeGreaterThan(kept.length);

          yield* clock.adjust("5 minutes");

          const after = yield* clock.withLive(
            Files.listNames(art).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("20 millis"),
                until: (names) => names.length === kept.length,
                times: 100,
              }),
            ),
          );

          expect(after.toSorted()).toEqual([...new Set(kept)].toSorted());
        }).pipe(Effect.provideService(Clock.Clock, clock));
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
