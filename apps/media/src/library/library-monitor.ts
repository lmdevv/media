import type { LibraryId } from "@media/contracts/ids";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  FiberMap,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import { fileSystemType } from "../platform/node-directories.ts";
import * as LibraryPoller from "./library-poller.ts";
import * as LibraryScanner from "./library-scanner.ts";

/** A library and the folders to keep in sync. */
export interface MonitoredLibrary {
  readonly libraryId: LibraryId;
  /** Absolute folder paths, as the library records them. */
  readonly roots: ReadonlyArray<string>;
}

type ScanReason = "startup" | "change" | "reconcile" | "job";

/** Scans and watches libraries. */
export interface Interface {
  /**
   * Scans every folder of `library` in order, after any scan of the same library already
   * running. Stops at the first folder that fails, so no folder's files are wrongly marked missing.
   */
  readonly scan: (
    library: MonitoredLibrary,
    mode: LibraryScanner.ScanMode,
    reason: ScanReason,
  ) => Effect.Effect<ReadonlyArray<LibraryScanner.ScanSummary>, LibraryScanner.ScanError>;
  /** Watches and reconciles exactly `libraries`, stopping libraries no longer listed. */
  readonly track: (libraries: ReadonlyArray<MonitoredLibrary>) => Effect.Effect<void>;
}

/** The library monitor. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/LibraryMonitor",
) {}

interface MonitorTiming {
  readonly debounce: Duration.Duration;
  readonly reconcileInterval: Duration.Duration;
  readonly pollInterval: Duration.Duration;
}

const DEFAULT_DEBOUNCE = Duration.seconds(3);

const HEALTHY_WATCH = Duration.minutes(10);

/** Failures in a row after a watch that ran `ranMillis` and failed, following `previous`. */
export const failuresAfter = (previous: number, ranMillis: number): number =>
  ranMillis >= Duration.toMillis(HEALTHY_WATCH) ? 1 : previous + 1;

/** A watcher that failed `failures` times in a row starts again after 1, 2, 4… s, at most 5 min. */
export const restartDelay = (failures: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 ** Math.min(Math.max(failures - 1, 0), 9)), Duration.minutes(5));

class WatchEnded extends Schema.TaggedError<WatchEnded>()("WatchEnded", {}) {}

type WatchMode = "events" | "poll";

const keyOf = (library: MonitoredLibrary): string =>
  `${library.libraryId}\u0000${library.roots.join("\u0000")}`;

const make = Effect.fn("LibraryMonitor.make")(function* (debounce: Duration.Duration) {
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* MediaConfig.Service;
  const path = yield* Path.Path;

  const timing: MonitorTiming = {
    debounce,
    reconcileInterval: config.reconcileInterval,
    pollInterval: config.libraryPollInterval,
  };

  const locks = yield* Ref.make<ReadonlyMap<LibraryId, Semaphore.Semaphore>>(new Map());
  const watchers = yield* FiberMap.make<string>();
  const tracked = yield* Ref.make<ReadonlySet<string>>(new Set());

  const lockOf = Effect.fnUntraced(function* (libraryId: LibraryId) {
    const fresh = yield* Semaphore.make(1);

    return yield* Ref.modify(locks, (current) => {
      const existing = current.get(libraryId);

      return existing === undefined
        ? [fresh, new Map(current).set(libraryId, fresh)]
        : [existing, current];
    });
  });

  const scan = Effect.fn("LibraryMonitor.scan")(
    function* (library: MonitoredLibrary, mode: LibraryScanner.ScanMode, reason: ScanReason) {
      const lock = yield* lockOf(library.libraryId);

      const summaries = yield* lock.withPermits(1)(
        Effect.forEach(library.roots, (root) =>
          scanner.scan({ libraryId: library.libraryId, root, mode }),
        ),
      );

      yield* Effect.logInfo("LibraryMonitor.scanned").pipe(
        Effect.annotateLogs({
          reason,
          discovered: summaries.reduce((total, summary) => total + summary.discovered, 0),
          processed: summaries.reduce((total, summary) => total + summary.processed, 0),
          unchanged: summaries.reduce((total, summary) => total + summary.unchanged, 0),
          missing: summaries.reduce((total, summary) => total + summary.missing, 0),
          failed: summaries.reduce((total, summary) => total + summary.failed, 0),
        }),
      );

      return summaries;
    },
    (effect, library, _mode, reason) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("LibraryMonitor.scan_failed", error).pipe(
            Effect.annotateLogs({ reason }),
          ),
        ),
        Effect.annotateLogs({ libraryId: library.libraryId }),
      ),
  );

  const identity = (root: string) =>
    fs.stat(root).pipe(
      Effect.map((info) => `${String(info.dev)}:${String(Option.getOrElse(info.ino, () => 0))}`),
      Effect.orElseSucceed(() => "missing"),
    );

  const snapshot = (root: string, previous: LibraryPoller.Snapshot) =>
    LibraryPoller.snapshot(root, previous).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const watchModeOf = Effect.fnUntraced(function* (root: string) {
    if (config.libraryWatch !== "auto") return config.libraryWatch satisfies WatchMode;

    const type = yield* Effect.tryPromise(() => fileSystemType(root)).pipe(Effect.option);

    // A folder `statfs` cannot read yet is usually a share that is not mounted; polling finds
    // its files once it is, where events would never report them.
    return Option.isNone(type) || LibraryPoller.isNetworkFileSystem(type.value)
      ? ("poll" as const)
      : ("events" as const);
  });

  const monitor = Effect.fn("LibraryMonitor.monitor")(
    function* (library: MonitoredLibrary) {
      const rescan = (reason: "change" | "reconcile") =>
        scan(library, "incremental", reason).pipe(Effect.ignore);

      const scanned = (reason: "change" | "reconcile") =>
        scan(library, "incremental", reason).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

      const restarts = yield* Ref.make(0);

      // After a restart, rescan: changes made while nothing watched were not reported. Node's
      // watcher reports its folder's removal as one event and then nothing, so every burst also
      // checks that the folder is still the one being watched.
      const watchEvents = (root: string) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(restarts)) > 0) yield* rescan("change");
          const watched = yield* identity(root);

          yield* fs.watch(root, { recursive: true }).pipe(
            Stream.debounce(timing.debounce),
            Stream.runForEach(() =>
              identity(root).pipe(
                Effect.flatMap((current) =>
                  current === watched ? rescan("change") : Effect.fail(new WatchEnded()),
                ),
              ),
            ),
          );

          return yield* new WatchEnded();
        });

      const poll = Effect.fnUntraced(function* (root: string) {
        let previous = (yield* snapshot(root, new Map())).snapshot;

        for (;;) {
          yield* Effect.sleep(timing.pollInterval);
          const next = yield* snapshot(root, previous);

          if (!next.changed || (yield* scanned("change"))) previous = next.snapshot;
        }
      });

      const watchOnce = (root: string) =>
        Effect.gen(function* () {
          const mode = yield* watchModeOf(root);

          yield* Effect.logInfo("LibraryMonitor.watching").pipe(Effect.annotateLogs({ mode }));

          return yield* mode === "poll" ? poll(root) : watchEvents(root);
        });

      const watch = Effect.fnUntraced(function* (root: string) {
        let failures = 0;

        for (;;) {
          const started = yield* Clock.currentTimeMillis;
          const error = yield* Effect.flip(watchOnce(root));
          const ran = (yield* Clock.currentTimeMillis) - started;

          failures = failuresAfter(failures, ran);
          yield* Ref.update(restarts, (count) => count + 1);
          yield* Effect.logWarning("LibraryMonitor.watch_failed", error);
          yield* Effect.sleep(restartDelay(failures));
        }
      });

      const watching = yield* Effect.forkChild(
        Effect.forEach(library.roots, watch, { concurrency: "unbounded", discard: true }),
      );

      const approved = yield* scan(library, "incremental", "startup").pipe(
        Effect.as(true),
        Effect.catchTag("LibraryRootNotApproved", () => Effect.succeed(false)),
        Effect.orElseSucceed(() => true),
      );

      if (!approved) return yield* Fiber.interrupt(watching);

      return yield* rescan("reconcile").pipe(
        Effect.delay(timing.reconcileInterval),
        Effect.forever,
      );
    },
    (effect, library) => effect.pipe(Effect.annotateLogs({ libraryId: library.libraryId })),
  );

  const track = Effect.fn("LibraryMonitor.track")(function* (
    libraries: ReadonlyArray<MonitoredLibrary>,
  ) {
    const wanted = new Map(libraries.map((library) => [keyOf(library), library]));
    const previous = yield* Ref.getAndSet(tracked, new Set(wanted.keys()));

    yield* Effect.forEach(
      [...previous].filter((key) => !wanted.has(key)),
      (key) => FiberMap.remove(watchers, key),
      { discard: true },
    );

    yield* Effect.forEach(
      [...wanted].filter(([key]) => !previous.has(key)),
      ([key, library]) => FiberMap.run(watchers, key, monitor(library), { onlyIfMissing: true }),
      { discard: true },
    );
  });

  return Service.of({ scan, track });
});

/** The monitor with nothing tracked yet. `debounce` is the quiet period before a change scan. */
export const layer = (
  debounce: Duration.Duration = DEFAULT_DEBOUNCE,
): Layer.Layer<
  Service,
  never,
  LibraryScanner.Service | FileSystem.FileSystem | Path.Path | MediaConfig.Service
> => Layer.effect(Service, make(debounce));

/** Tracks a fixed set of libraries for the lifetime of the layer, as standalone mode does. */
export const layerTracking = (
  libraries: ReadonlyArray<MonitoredLibrary>,
): Layer.Layer<never, never, Service> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const monitor = yield* Service;

      yield* monitor.track(libraries);
    }),
  );
