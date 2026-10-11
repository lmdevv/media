import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect, Layer, Schedule } from "effect";

import * as Files from "./files.ts";
import * as LibraryWatcher from "./library-watcher.ts";
import { MEDIA_TEST_TIMEOUT, temporaryDirectory, testConfig } from "./testing/fixtures.ts";
import { layerMemory, MemoryMediaBackendControl } from "./testing/memory-media-backend.ts";
import { runScoped } from "./testing/run.ts";

describe("LibraryWatcher", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("requests a scan at startup and again after files change", () =>
    runScoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("library");
        const dataDir = yield* temporaryDirectory("data");
        const services = Layer.merge(layerMemory, testConfig(dataDir));

        const context = yield* Layer.build(
          Layer.merge(services, LibraryWatcher.layer.pipe(Layer.provide(services))),
        );

        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));

        yield* control.addLibrary(root);

        const pendingJobs = control.jobs.pipe(
          Effect.map((jobs) => jobs.filter((job) => job.status === "pending")),
        );

        const waitForPending = pendingJobs.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("50 millis"),
            until: (jobs) => jobs.length > 0,
            times: 300,
          }),
        );

        const [startup] = yield* waitForPending;

        if (startup === undefined) expect.unreachable("no scan was requested at startup");
        yield* control.cancelJob(startup.id);

        yield* Files.makeDirectory(join(root, "Artist", "Album"));
        yield* Files.writeFileAtomic(
          join(root, "Artist", "Album", "01 Song.mp3"),
          new Uint8Array([1, 2, 3]),
          "w",
        );
        yield* Files.writeFileAtomic(join(root, ".hidden-temp"), new Uint8Array([1]), "w");
        const [changed] = yield* waitForPending;

        expect(changed?.id).not.toBe(startup.id);
        expect(yield* control.jobs).toHaveLength(2);
      }),
    ));
});
