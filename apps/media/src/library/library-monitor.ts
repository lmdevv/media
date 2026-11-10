import { createHash } from "node:crypto";

import { LibraryId } from "@media/contracts/ids";
import type { CallError } from "@media/sdk/effect";
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

/** Most paths one burst of file events keeps before it counts as a change to the whole root. */
const BURST_PATHS_MAX = 256;

/** Why a library is brought up to date. */
type ScanReason = "startup" | "change" | "reconcile";

/**
 * Brings `library` up to date after `reason`. `changed` lists the absolute paths a burst of file
 * events named, and is empty when the whole library may have changed: at startup, on the reconcile
 * interval, after a watcher restart, and when a polled folder changed. `LibraryRootNotApproved`
 * at startup stops watching the library.
 */
export type Rescan = (
  library: MonitoredLibrary,
  reason: ScanReason,
  changed: ReadonlyArray<string>,
) => Effect.Effect<unknown, LibraryScanner.ScanError | CallError>;

/** Watches libraries and brings them up to date. */
export interface Interface {
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

const make = Effect.fn("LibraryMonitor.make")(function* (
  debounce: Duration.Duration,
  rescanLibrary: Rescan,
) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* MediaConfig.Service;
  const path = yield* Path.Path;

  const timing: MonitorTiming = {
    debounce,
    reconcileInterval: config.reconcileInterval,
    pollInterval: config.libraryPollInterval,
  };

  const watchers = yield* FiberMap.make<string>();
  const tracked = yield* Ref.make<ReadonlySet<string>>(new Set());

  const scan = (library: MonitoredLibrary, reason: ScanReason, changed: ReadonlyArray<string>) =>
    rescanLibrary(library, reason, changed).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("LibraryMonitor.scan_failed", error).pipe(
          Effect.annotateLogs({ reason }),
        ),
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
      const rescan = (reason: "change" | "reconcile", changed: ReadonlyArray<string> = []) =>
        scan(library, reason, changed).pipe(Effect.ignore);

      const scanned = (reason: "change" | "reconcile") =>
        scan(library, reason, []).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

      const restarts = yield* Ref.make(0);

      // After a restart, rescan: changes made while nothing watched were not reported. Node's
      // watcher reports its folder's removal as one event and then nothing, so every burst also
      // checks that the folder is still the one being watched. A burst's events name paths
      // relative to the folder; the rescan gets them whole.
      const watchEvents = (root: string) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(restarts)) > 0) yield* rescan("change");
          const watched = yield* identity(root);
          // Past `BURST_PATHS_MAX` paths a burst stops keeping them and counts as the whole root.
          let burst: Set<string> | null = new Set();

          const takeBurst = Effect.sync((): ReadonlyArray<string> => {
            const taken = burst === null ? [] : [...burst];

            burst = new Set();

            return taken;
          });

          yield* fs.watch(root, { recursive: true }).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (burst === null) return;

                burst.add(path.join(root, event.path));

                if (burst.size > BURST_PATHS_MAX) burst = null;
              }),
            ),
            Stream.debounce(timing.debounce),
            Stream.runForEach(() =>
              identity(root).pipe(
                Effect.flatMap((current) =>
                  current === watched
                    ? Effect.flatMap(takeBurst, (changed) => rescan("change", changed))
                    : Effect.fail(new WatchEnded()),
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

      const approved = yield* scan(library, "startup", []).pipe(
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

  return Service.of({ track });
});

/**
 * The monitor with nothing tracked yet, bringing each library up to date with `rescan`. `debounce`
 * is the quiet period before a change rescans.
 */
export const layerWith = (
  rescan: Rescan,
  debounce: Duration.Duration = DEFAULT_DEBOUNCE,
): Layer.Layer<Service, never, FileSystem.FileSystem | Path.Path | MediaConfig.Service> =>
  Layer.effect(Service, make(debounce, rescan));

/**
 * The monitor scanning in this process, as standalone mode does: every folder of a library in
 * order, after any scan of the same library already running, stopping at the first folder that
 * fails, so no folder's files are wrongly marked missing.
 */
export const layer = (
  debounce: Duration.Duration = DEFAULT_DEBOUNCE,
): Layer.Layer<
  Service,
  never,
  LibraryScanner.Service | FileSystem.FileSystem | Path.Path | MediaConfig.Service
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const scanner = yield* LibraryScanner.Service;
      const locks = yield* Ref.make<ReadonlyMap<LibraryId, Semaphore.Semaphore>>(new Map());

      const lockOf = Effect.fnUntraced(function* (libraryId: LibraryId) {
        const fresh = yield* Semaphore.make(1);

        return yield* Ref.modify(locks, (current) => {
          const existing = current.get(libraryId);

          return existing === undefined
            ? [fresh, new Map(current).set(libraryId, fresh)]
            : [existing, current];
        });
      });

      const scan: Rescan = Effect.fn("LibraryMonitor.scan")(
        function* (library, reason) {
          const lock = yield* lockOf(library.libraryId);

          const summaries = yield* lock.withPermits(1)(
            Effect.forEach(library.roots, (root) =>
              scanner.scan({ libraryId: library.libraryId, root, mode: "incremental" }),
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
        },
        (effect, library) => effect.pipe(Effect.annotateLogs({ libraryId: library.libraryId })),
      );

      return layerWith(scan, debounce);
    }),
  );

/** Each approved root as a library of its own, named by a digest of its path, for watching. */
export const rootLibraries = (roots: ReadonlyArray<string>): ReadonlyArray<MonitoredLibrary> =>
  roots.map((root) => ({
    libraryId: LibraryId.make(
      `root-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
    ),
    roots: [root],
  }));

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
