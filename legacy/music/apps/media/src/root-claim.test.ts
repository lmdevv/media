import { dirname, join } from "node:path";

import { SYSTEM_FOLDER_MESSAGE } from "@music/commands/system-folders";
import { describe, expect, it } from "vitest";
import { LibraryId } from "@music/commands/ids";
import { Effect, Layer, Schedule } from "effect";

import * as Files from "./files.ts";
import * as JobWorker from "./job-worker.ts";
import * as RootClaim from "./root-claim.ts";
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

/** A job worker over the in-memory backend, with `musicRoots` as `MUSIC_ROOTS`. */
const worker = (dataDir: string, musicRoots: ReadonlyArray<string> | null = null) =>
  Effect.gen(function* () {
    const services = Layer.merge(
      layerMemory,
      testConfig(dataDir, undefined, undefined, musicRoots),
    );

    const context = yield* Layer.build(
      Layer.merge(services, JobWorker.layer.pipe(Layer.provide(services))),
    );

    return yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
  });

/** The claim pass alone over the in-memory backend: no job worker, so nothing is scanned. */
const claimPass = (dataDir: string) =>
  Effect.gen(function* () {
    const services = Layer.merge(layerMemory, testConfig(dataDir));

    const context = yield* Layer.build(
      Layer.merge(services, RootClaim.layer.pipe(Layer.provide(services))),
    );

    return yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
  });

/** Waits until `libraryId` is claimed, or gives up after about ten seconds. */
const claimedSoon = (control: MemoryMediaBackendControl["Service"], libraryId: string) =>
  control.claimed.pipe(
    Effect.map((ids) => ids.includes(LibraryId.make(libraryId))),
    Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (done) => done, times: 500 }),
  );

const scanOf = (control: MemoryMediaBackendControl["Service"], path: string) =>
  Effect.gen(function* () {
    const libraryId = yield* control.addLibrary(path);
    const jobId = yield* control.enqueueScan(libraryId);

    const job = yield* control.jobs.pipe(
      Effect.map((jobs) => jobById(jobs, jobId)),
      Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: isSettled, times: 500 }),
    );

    const tracks = (yield* control.tracks).filter((track) => track.libraryId === libraryId);

    return { job, tracks };
  });

describe("root claims", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("refuses a link to another library's folder, indexing nothing", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const control = yield* worker(yield* temporaryDirectory("data"));
        const links = yield* temporaryDirectory("links");

        // The same folder, and the folder around it, by other names.
        yield* Files.makeSymlink(root, join(links, "same"));
        yield* Files.makeSymlink(dirname(root), join(links, "around"));

        const first = yield* scanOf(control, root);

        expect(first.job?.status).toBe("done");
        expect(first.tracks).toHaveLength(10);

        for (const alias of ["same", "around"]) {
          const second = yield* scanOf(control, join(links, alias));

          expect(second.job?.outcome).toEqual({
            status: "failed",
            error: "This folder overlaps another library",
          });
          expect(second.tracks).toEqual([]);
        }
      }),
    ));

  it("tells folders apart by identity, as a bind mount can't hide", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const base = yield* temporaryDirectory("nest");
        const music = join(base, "music");
        const inner = join(music, "inner");
        const beside = join(base, "beside");

        yield* Files.copyTree(root, music);
        yield* Files.makeDirectory(inner);
        yield* Files.makeDirectory(beside);

        // Each chain is the folder, then each folder above it up to `/`.
        const [innerIds, musicIds, topIds] = yield* Effect.all([
          Files.folderIds(inner),
          Files.folderIds(music),
          Files.folderIds("/"),
        ]);

        expect(innerIds.slice(1)).toEqual(musicIds);
        expect(innerIds.at(-1)).toBe(topIds[0]);

        // The in-memory backend compares identities only, never paths.
        const control = yield* worker(yield* temporaryDirectory("data"));
        const first = yield* scanOf(control, music);

        expect(first.job?.status).toBe("done");
        expect(first.tracks).toHaveLength(10);

        const nested = yield* scanOf(control, inner);

        expect(nested.job?.outcome).toEqual({
          status: "failed",
          error: "This folder overlaps another library",
        });

        const apart = yield* scanOf(control, beside);

        expect(apart.job?.status).toBe("done");
      }),
    ));

  it("claims every unclaimed library at once, ahead of any scan", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const control = yield* claimPass(yield* temporaryDirectory("data"));
        const base = yield* temporaryDirectory("upgrade");
        const folders = ["one", "two", "three"].map((name) => join(base, name));

        yield* Effect.forEach(folders, (folder) => Files.copyTree(root, folder), { discard: true });

        // As after an upgrade: libraries indexed by an older version, none of them claimed.
        const ids = yield* Effect.forEach(folders, (folder) => control.addLibrary(folder));

        const claimed = yield* Effect.forEach(ids, (id) => claimedSoon(control, id));

        expect(claimed).toEqual([true, true, true]);
        // Claimed without a single scan: they stream again before their full scans run.
        expect(yield* control.jobs).toEqual([]);

        // A folder inside a claimed one is still refused, and claims nothing.
        const inner = join(folders[0] ?? base, "inner");

        yield* Files.makeDirectory(inner);
        const nested = yield* control.addLibrary(inner);

        yield* Effect.sleep("300 millis");
        expect(yield* control.claimed).not.toContain(nested);
        expect(yield* control.jobs).toEqual([]);
      }),
    ));

  it("tries a claim that failed for a passing reason again, with backoff", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const control = yield* claimPass(yield* temporaryDirectory("data"));
        // Not mounted yet when the library appears, as a drive that comes up after the service.
        const later = join(yield* temporaryDirectory("later"), "music");
        const libraryId = yield* control.addLibrary(later);

        yield* Effect.sleep("300 millis");
        expect(yield* control.claimed).not.toContain(libraryId);

        yield* Files.copyTree(root, later);

        expect(yield* claimedSoon(control, libraryId)).toBe(true);
      }),
    ));

  it("refuses /proc/self/root, which names the whole file system again", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const control = yield* worker(yield* temporaryDirectory("data"));
        const { job, tracks } = yield* scanOf(control, `/proc/self/root${root}`);

        expect(job?.outcome).toEqual({
          status: "failed",
          error: SYSTEM_FOLDER_MESSAGE,
        });
        expect(tracks).toEqual([]);
      }),
    ));

  it("scans only inside MUSIC_ROOTS, following links to their real folders", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const allowed = yield* temporaryDirectory("allowed");
        const escape = join(allowed, "escape");

        yield* Files.makeSymlink(root, escape);
        const control = yield* worker(yield* temporaryDirectory("data"), [allowed]);
        const { job, tracks } = yield* scanOf(control, escape);

        expect(job?.outcome).toEqual({
          status: "failed",
          error: `Library folders must be inside ${allowed} (MUSIC_ROOTS)`,
        });
        expect(tracks).toEqual([]);
      }),
    ));
});
