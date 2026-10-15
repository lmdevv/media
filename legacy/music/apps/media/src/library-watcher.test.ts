import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect, Layer, Ref, Schedule } from "effect";

import * as Files from "./files.ts";
import * as LibraryWatcher from "./library-watcher.ts";
import { MEDIA_TEST_TIMEOUT, temporaryDirectory, testConfig } from "./testing/fixtures.ts";
import { layerMemory, MemoryMediaBackendControl } from "./testing/memory-media-backend.ts";
import { runScoped } from "./testing/run.ts";

/** The message of a watch that failed with the Node error `code`. */
const failedWith = (code: string): string =>
  new LibraryWatcher.WatchError({
    path: "/music",
    cause: Object.assign(new Error(`${code}: System limit reached`), { code }),
  }).message;

describe("LibraryWatcher", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("starts a failed watch again, scans for what it missed, then follows changes", () =>
    runScoped(
      Effect.gen(function* () {
        const parent = yield* temporaryDirectory("parent");
        const dataDir = yield* temporaryDirectory("data");
        // Not there yet, as a drive that is mounted after the service started.
        const root = join(parent, "library");
        const services = Layer.merge(layerMemory, testConfig(dataDir));

        const context = yield* Layer.build(
          Layer.merge(services, LibraryWatcher.layer.pipe(Layer.provide(services))),
        );

        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));

        yield* control.addLibrary(root);

        const waitForPending = control.jobs.pipe(
          Effect.map((jobs) => jobs.filter((job) => job.status === "pending")),
          Effect.repeat({
            schedule: Schedule.spaced("50 millis"),
            until: (jobs) => jobs.length > 0,
            times: 400,
          }),
        );

        const [startup] = yield* waitForPending;

        if (startup === undefined) expect.unreachable("no scan was requested at startup");
        yield* control.cancelJob(startup.id);

        // The watch failed to start on the missing folder; once the folder is there, the watch
        // starts again and asks for a scan of what it could not see.
        yield* Files.makeDirectory(root);
        const [restarted] = yield* waitForPending;

        if (restarted === undefined) expect.unreachable("no scan was requested after the restart");
        expect(restarted.id).not.toBe(startup.id);
        yield* control.cancelJob(restarted.id);

        yield* Files.writeFileAtomic(join(root, "01 Song.mp3"), new Uint8Array([1, 2, 3]), "w");
        const [changed] = yield* waitForPending;

        if (changed === undefined) expect.unreachable("no scan was requested after a change");
        expect(changed.id).not.toBe(restarted.id);
        yield* control.cancelJob(changed.id);

        // The folder goes away (a drive unmounted) and comes back: the watch follows it.
        yield* Files.removePath(root);
        yield* Effect.sleep("500 millis");
        yield* Files.makeDirectory(root);
        const [back] = yield* waitForPending;

        if (back === undefined)
          expect.unreachable("no scan was requested once the folder was back");
        yield* control.cancelJob(back.id);

        yield* Files.writeFileAtomic(join(root, "02 Song.mp3"), new Uint8Array([1, 2, 3]), "w");
        yield* waitForPending;
        expect(yield* control.jobs).toHaveLength(5);
      }),
    ));

  it("sees a link that went from one folder, to nowhere, to another as moved", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const last = yield* Ref.make<string | null>(null);

        const moves = yield* Effect.forEach(["/a", null, "/b", "/b", null, "/b"], (real) =>
          LibraryWatcher.movedSince(last, real),
        );

        expect(moves).toEqual([false, false, true, false, false, false]);
      }),
    ));

  it("names the sysctl to raise when the system's watch limits are reached", () => {
    expect(failedWith("ENOSPC")).toContain("sysctl -w fs.inotify.max_user_watches=");
    expect(failedWith("EMFILE")).toContain("sysctl -w fs.inotify.max_user_instances=");
    expect(failedWith("EACCES")).toBe(
      "Folder watch failed: /music. Changes are found by the periodic rescan until the watch " +
        "starts again.",
    );
  });

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
