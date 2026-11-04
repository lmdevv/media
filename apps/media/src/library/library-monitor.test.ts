import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Ref, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { test } from "vitest";

import * as DiskCache from "../disk-cache.ts";
import { LibraryId } from "@media/contracts/ids";
import * as MediaTools from "../media/media-tools.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import * as Omdb from "../metadata/omdb.ts";
import * as Tmdb from "../metadata/tmdb.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { copyBytes, copyTree } from "../testing/byte-copies.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as LibraryMonitor from "./library-monitor.ts";
import * as LibraryScanner from "./library-scanner.ts";
import * as LibrarySink from "./library-sink.ts";
import * as MemoryLibrary from "./memory-library.ts";

const hasFfmpeg = await ffmpegAvailable();

const libraryId = LibraryId.make("watched");

class Watched extends Context.Service<Watched, { readonly root: string }>()(
  "test/WatchedLibrary",
) {}

class StoreOutage extends Context.Service<
  StoreOutage,
  { readonly down: Ref.Ref<boolean>; readonly refused: Ref.Ref<number> }
>()("test/StoreOutage") {}

const storeOutageLayer = Layer.effect(
  StoreOutage,
  Effect.gen(function* () {
    return StoreOutage.of({ down: yield* Ref.make(false), refused: yield* Ref.make(0) });
  }),
);

const outageSinkLayer = Layer.effect(
  LibrarySink.Service,
  Effect.gen(function* () {
    const sink = yield* LibrarySink.Service;
    const { down, refused } = yield* StoreOutage;

    return LibrarySink.Service.of({
      ...sink,
      previousIndex: (folder) =>
        Effect.flatMap(Ref.get(down), (isDown) =>
          isDown
            ? Ref.update(refused, (count) => count + 1).pipe(
                Effect.andThen(
                  Effect.fail(
                    new LibrarySink.LibrarySinkFailed({
                      operation: "previousIndex",
                      cause: "the store is down",
                    }),
                  ),
                ),
              )
            : sink.previousIndex(folder),
        ),
    });
  }),
);

const monitorLayer = (overrides: Readonly<Record<string, string>> = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const workspace = yield* FixtureWorkspace.Service;
      const path = yield* Path.Path;
      const copy = yield* workspace.copy.pipe(Effect.orDie);

      const config = testConfigLayer({
        LIBRARY_ROOTS: workspace.root,
        DATA_DIR: path.join(workspace.root, "data"),
        LIBRARY_RECONCILE_MINUTES: "600",
        ...overrides,
      });

      const scanner = LibraryScanner.layer.pipe(
        Layer.provide(outageSinkLayer),
        Layer.provideMerge(storeOutageLayer),
        Layer.provideMerge(MemoryLibrary.layer),
        Layer.provide(MetadataResolver.layer),
        Layer.provide(Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none()))),
        Layer.provide(Omdb.layerWithOptions(Omdb.defaultOptions(Option.none()))),
        Layer.provide(DiskCache.layer),
        Layer.provide(MediaTools.layer),
      );

      const monitor = LibraryMonitor.layerTracking([{ libraryId, roots: [copy.movies] }]).pipe(
        Layer.provideMerge(LibraryMonitor.layer(Duration.millis(200))),
      );

      return monitor.pipe(
        Layer.merge(Layer.succeed(Watched, Watched.of({ root: copy.movies }))),
        Layer.provideMerge(scanner),
        Layer.provideMerge(config),
      );
    }),
  ).pipe(
    Layer.provideMerge(FixtureWorkspace.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );

const eventually = (check: (files: ReadonlyMap<string, MemoryLibrary.StoredFile>) => boolean) =>
  Effect.gen(function* () {
    const library = yield* MemoryLibrary.Service;

    const files = new Map(
      (yield* library.files(libraryId)).map((file) => [file.record.relativePath, file]),
    );

    return check(files) ? Option.some(files) : Option.none();
  }).pipe(
    Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout("15 seconds"),
    Effect.orDie,
  );

describe.skipIf(!hasFfmpeg)("LibraryMonitor", () => {
  layer(monitorLayer({ LIBRARY_WATCH: "events" }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect(
      "scans at startup and rescans after file changes",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const { root } = yield* Watched;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* eventually((files) => files.size === 4);
          yield* fs.makeDirectory(path.join(root, "New Movie (2024)"));
          yield* copyBytes(
            path.join(root, library.messyMovie),
            path.join(root, "New Movie (2024)", "New Movie (2024).mkv"),
          );

          const added = yield* eventually((files) =>
            files.has("New Movie (2024)/New Movie (2024).mkv"),
          );

          assert.strictEqual(
            Option.getOrUndefined(added)?.get("New Movie (2024)/New Movie (2024).mkv")?.record.title
              ?.title,
            "New Movie",
          );

          yield* fs.remove(path.join(root, library.messyMovie));
          yield* eventually((files) => files.get(library.messyMovie)?.missing === true);
        }),
      60_000,
    );

    it.effect(
      "starts watching again after the library folder goes away and comes back",
      () =>
        Effect.gen(function* () {
          const { root } = yield* Watched;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parked = `${root}.parked`;

          yield* eventually((files) => files.has("New Movie (2024)/New Movie (2024).mkv"));

          yield* copyTree(root, parked);
          yield* fs.remove(root, { recursive: true });
          yield* Effect.sleep(Duration.millis(500));
          yield* fs.makeDirectory(path.join(parked, "Returned (2025)"));
          yield* copyBytes(
            path.join(parked, "New Movie (2024)", "New Movie (2024).mkv"),
            path.join(parked, "Returned (2025)", "Returned (2025).mkv"),
          );
          yield* fs.rename(parked, root);

          yield* eventually((files) => files.has("Returned (2025)/Returned (2025).mkv"));
        }),
      60_000,
    );
  });

  layer(monitorLayer({ LIBRARY_WATCH: "poll", LIBRARY_POLL_SECONDS: "1" }), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })((it) => {
    it.effect(
      "polls a library that sends no file events",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const { root } = yield* Watched;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* eventually((files) => files.size === 4);
          yield* fs.makeDirectory(path.join(root, "Polled (2023)"));
          yield* copyBytes(
            path.join(root, library.messyMovie),
            path.join(root, "Polled (2023)", "Polled (2023).mkv"),
          );

          yield* eventually((files) => files.has("Polled (2023)/Polled (2023).mkv"));
        }),
      60_000,
    );

    it.effect(
      "scans a polled change again when the store refused its scan",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const { root } = yield* Watched;
          const { down, refused } = yield* StoreOutage;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* eventually((files) => files.has("Polled (2023)/Polled (2023).mkv"));
          yield* Ref.set(down, true);
          yield* fs.makeDirectory(path.join(root, "Retried (2024)"));
          yield* copyBytes(
            path.join(root, library.messyMovie),
            path.join(root, "Retried (2024)", "Retried (2024).mkv"),
          );

          yield* Ref.get(refused).pipe(
            Effect.repeat({ until: (count) => count > 0, schedule: Schedule.spaced("100 millis") }),
            Effect.timeout("15 seconds"),
            Effect.orDie,
          );
          yield* Ref.set(down, false);

          yield* eventually((files) => files.has("Retried (2024)/Retried (2024).mkv"));
        }),
      60_000,
    );
  });
});

describe("watch restarts", () => {
  test("back off while a watch keeps failing, and start over after one that ran well", () => {
    const delays: Array<number> = [];
    let failures = 0;

    for (const ranMillis of [10, 10, 10, 10, 10, 10, 3_600_000, 10]) {
      failures = LibraryMonitor.failuresAfter(failures, ranMillis);
      delays.push(Duration.toSeconds(LibraryMonitor.restartDelay(failures)));
    }

    assert.deepStrictEqual(delays, [1, 2, 4, 8, 16, 32, 1, 2]);
    assert.strictEqual(Duration.toMinutes(LibraryMonitor.restartDelay(40)), 5);
  });
});
