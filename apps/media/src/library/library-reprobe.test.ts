import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, Path, Struct } from "effect";

import { LibraryId } from "@media/contracts/ids";
import { PROBE_REVISION } from "../media/media-probe.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { scannerLayer, storedOf } from "../testing/memory-scanner.ts";
import * as LibraryScanner from "./library-scanner.ts";
import * as LibrarySink from "./library-sink.ts";

const hasFfmpeg = await ffmpegAvailable();

/** The files the scans here logged keeping their old probe, in the order they logged them. */
const kept: Array<string> = [];

/** Notes each `LibraryScanner.probe_kept` a scan logs. */
const keptLogs = Logger.layer(
  [
    Logger.map(Logger.formatStructured, (record) => {
      if (record.message === "LibraryScanner.probe_kept") {
        kept.push(String(record.annotations["relativePath"]));
      }
    }),
  ],
  { mergeWithExisting: true },
);

/** The title an earlier match through a metadata provider gave a file, which its own files do not. */
const ELSEWHERE = "Matched Elsewhere";

/**
 * Stores `relativePath`'s record as an older reader and an earlier match left it: an older probe
 * revision, a probe without a field order and with another frame rate, and the title a provider
 * gave it. Answers the record as this scanner stored it.
 */
const aged = Effect.fn(function* (libraryId: LibraryId, root: string, relativePath: string) {
  const sink = yield* LibrarySink.Service;
  const fresh = yield* storedOf(libraryId, relativePath);
  const video = fresh.probe.video;

  yield* sink.upsertBatch({ libraryId, root }, [
    Struct.assign(fresh, {
      probeRevision: PROBE_REVISION - 1,
      probe: Struct.assign(fresh.probe, {
        video:
          video === undefined
            ? undefined
            : Struct.assign(video, { fieldOrder: undefined, frameRate: 1 }),
      }),
      title:
        fresh.title === undefined ? undefined : Struct.assign(fresh.title, { title: ELSEWHERE }),
    }),
  ]);

  return fresh;
});

/** `sink`, where a write of probes read again stores the first and then fails, as a stop would. */
const storesOneThenStops = (sink: LibrarySink.Interface): LibrarySink.Interface =>
  LibrarySink.Service.of({
    ...sink,
    reprobed: (folder, files) =>
      sink.reprobed(folder, files.slice(0, 1)).pipe(
        Effect.andThen(
          Effect.fail(
            new LibrarySink.LibrarySinkFailed({
              operation: "reprobed",
              cause: "the service stopped",
            }),
          ),
        ),
      ),
  });

/** `sink`, where no probe read again fits beside the rest of its file's row, so none is stored. */
const fitsNone = (sink: LibrarySink.Interface): LibrarySink.Interface =>
  LibrarySink.Service.of({
    ...sink,
    reprobed: (_folder, files) =>
      Effect.succeed({ written: 0, unfit: files.map((file) => file.relativePath) }),
  });

describe.skipIf(!hasFfmpeg)("probing unchanged files again", () => {
  layer(Layer.merge(scannerLayer, keptLogs), { excludeTestServices: true, timeout: "60 seconds" })(
    (it) => {
      it.effect(
        "probes an unchanged file again when an older reader stored its probe, and stores only the probe",
        () =>
          Effect.gen(function* () {
            const { library, copy } = yield* FixtureWorkspace.Service;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const target = yield* copy;
            const scanner = yield* LibraryScanner.Service;
            const libraryId = LibraryId.make("older-probes");
            const request = { libraryId, root: target.movies, mode: "incremental" } as const;

            yield* scanner.scan(request);
            const fresh = yield* aged(libraryId, target.movies, library.directMovie);
            const old = yield* storedOf(libraryId, library.directMovie);
            const again = yield* scanner.scan(request);
            const read = yield* storedOf(libraryId, library.directMovie);

            // The title an earlier match found stays, with everything else stored of the file.
            // Metadata providers are unavailable here: matching again would have replaced it.
            assert.strictEqual(read.title?.title, ELSEWHERE);
            assert.deepStrictEqual(
              Struct.omit(read, ["probe", "probeRevision"]),
              Struct.omit(old, ["probe", "probeRevision"]),
            );
            assert.strictEqual(read.probeRevision, PROBE_REVISION);
            assert.deepStrictEqual(read.probe, fresh.probe);
            assert.deepStrictEqual(
              [again.reprobed, again.processed, again.unchanged, again.failed],
              [1, 0, 3, 0],
            );

            const settled = yield* scanner.scan(request);

            assert.deepStrictEqual([settled.reprobed, settled.unchanged], [0, 4]);

            // A file whose bytes change is read whole and matched again, as any changed file is.
            yield* aged(libraryId, target.movies, library.directMovie);
            yield* fs.utimes(
              path.join(target.movies, library.directMovie),
              new Date(),
              new Date(2001, 1, 1),
            );
            const changed = yield* scanner.scan(request);
            const matched = yield* storedOf(libraryId, library.directMovie);

            assert.deepStrictEqual([changed.reprobed, changed.processed], [0, 1]);
            assert.strictEqual(matched.title?.title, fresh.title?.title);
            assert.strictEqual(matched.probeRevision, PROBE_REVISION);
          }),
      );

      it.effect(
        "keeps the stored row of a file that fails to probe again, goes on with the others, and tries it at each scan",
        () =>
          Effect.gen(function* () {
            const { library, copy } = yield* FixtureWorkspace.Service;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const target = yield* copy;
            const scanner = yield* LibraryScanner.Service;
            const libraryId = LibraryId.make("unreadable-probes");
            const request = { libraryId, root: target.movies, mode: "incremental" } as const;
            const unreadable = path.join(target.movies, library.directMovie);

            yield* scanner.scan(request);
            yield* aged(libraryId, target.movies, library.directMovie);
            yield* aged(libraryId, target.movies, library.messyMovie);
            const old = yield* storedOf(libraryId, library.directMovie);

            // Its size and modification time stay as stored, but ffprobe cannot read it.
            yield* fs.chmod(unreadable, 0o000);

            const first = yield* scanner.scan(request);
            const second = yield* scanner.scan(request);

            assert.deepStrictEqual(
              [first, second].map((scan) => [scan.reprobed, scan.failed, scan.failures.length]),
              [
                [1, 1, 1],
                [0, 1, 1],
              ],
            );
            assert.deepStrictEqual(yield* storedOf(libraryId, library.directMovie), old);
            assert.strictEqual(
              (yield* storedOf(libraryId, library.messyMovie)).probeRevision,
              PROBE_REVISION,
            );

            yield* fs.chmod(unreadable, 0o644);
            const readable = yield* scanner.scan(request);

            assert.deepStrictEqual([readable.reprobed, readable.failed], [1, 0]);
          }),
      );

      it.effect("continues probing files again where a stopped scan left off", () =>
        Effect.gen(function* () {
          const { library, copy } = yield* FixtureWorkspace.Service;
          const target = yield* copy;
          const scanner = yield* LibraryScanner.Service;
          const sink = yield* LibrarySink.Service;
          const libraryId = LibraryId.make("stopped-probes");
          const request = { libraryId, root: target.movies, mode: "incremental" } as const;
          const files = [library.directMovie, library.messyMovie, library.hdrMovie];

          yield* scanner.scan(request);

          for (const relativePath of files) yield* aged(libraryId, target.movies, relativePath);

          // The service stops while the core takes the probes: it stored one, then nothing more.
          const stopping = yield* LibraryScanner.make.pipe(
            Effect.provideService(LibrarySink.Service, storesOneThenStops(sink)),
          );

          const stopped = yield* Effect.flip(stopping.scan(request));

          const revisions = yield* Effect.forEach(files, (relativePath) =>
            Effect.map(storedOf(libraryId, relativePath), (stored) => stored.probeRevision),
          );

          assert.instanceOf(stopped, LibrarySink.LibrarySinkFailed);
          assert.strictEqual(revisions.filter((revision) => revision === PROBE_REVISION).length, 1);

          const rest = yield* scanner.scan(request);

          assert.deepStrictEqual([rest.reprobed, rest.unchanged], [2, 2]);

          for (const relativePath of files) {
            assert.strictEqual(
              (yield* storedOf(libraryId, relativePath)).probeRevision,
              PROBE_REVISION,
            );
          }
        }),
      );

      it.effect(
        "keeps a file's old probe when its new one does not fit beside its row, says so once a scan, and counts it kept",
        () =>
          Effect.gen(function* () {
            const { library, copy } = yield* FixtureWorkspace.Service;
            const target = yield* copy;
            const scanner = yield* LibraryScanner.Service;
            const sink = yield* LibrarySink.Service;
            const libraryId = LibraryId.make("unfit-probes");
            const request = { libraryId, root: target.movies, mode: "incremental" } as const;
            const files = [library.directMovie, library.messyMovie];

            yield* scanner.scan(request);

            for (const relativePath of files) yield* aged(libraryId, target.movies, relativePath);

            const unfit = yield* LibraryScanner.make.pipe(
              Effect.provideService(LibrarySink.Service, fitsNone(sink)),
            );

            const scans = yield* Effect.forEach([1, 2], () => unfit.scan(request));

            assert.deepStrictEqual(
              scans.map((scan) => [scan.reprobed, scan.reprobeKept, scan.unchanged]),
              [
                [0, 2, 2],
                [0, 2, 2],
              ],
            );
            assert.deepStrictEqual(kept.toSorted(), [...files, ...files].toSorted());

            for (const relativePath of files) {
              assert.strictEqual(
                (yield* storedOf(libraryId, relativePath)).probeRevision,
                PROBE_REVISION - 1,
              );
            }
          }),
      );
    },
  );
});
