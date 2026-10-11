/**
 * Requests scans when library folders change. Each library gets a recursive `fs.watch`, debounced
 * so a burst of changes becomes one scan, plus a periodic rescan for file systems that send no
 * change events (SMB, NFS). The first periodic scan runs at startup to catch changes made while
 * the service was down. Convex collapses requests into the library's pending or running job.
 */
import { Cause, Effect, FiberMap, Layer, Queue, Ref, Schedule, Schema, Stream } from "effect";

import { type LibraryFolder, MediaBackend, resubscribeSchedule } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";
import { watchTree } from "./platform/node-watch.ts";

const DEBOUNCE = "5 seconds";

/** The folder watcher failed to start or stopped. Periodic rescans continue regardless. */
class WatchError extends Schema.TaggedError<WatchError>()("WatchError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Folder watch failed: ${this.path}`;
  }
}

const isHidden = (relativePath: string): boolean =>
  relativePath.split(/[\\/]/).some((segment) => segment.startsWith("."));

/** Emits once for every visible change under `path`. */
const folderChanges = (path: string): Stream.Stream<void, WatchError> =>
  Stream.callback<void, WatchError>((queue) =>
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          watchTree(
            path,
            (relativePath) => {
              if (relativePath === null || !isHidden(relativePath))
                Queue.offerUnsafe(queue, undefined);
            },
            (cause) => {
              Queue.failCauseUnsafe(queue, Cause.fail(new WatchError({ path, cause })));
            },
          ),
        catch: (cause) => new WatchError({ path, cause }),
      }),
      (stop) =>
        Effect.sync(() => {
          stop();
        }),
    ),
  );

const watchLibrary = Effect.fn("LibraryWatcher.watch")(
  function* (library: LibraryFolder) {
    const backend = yield* MediaBackend;
    const config = yield* MediaConfig;

    const requestScan = (reason: string): Effect.Effect<void> =>
      backend.requestScan(library.id).pipe(
        Effect.tap(() =>
          Effect.logDebug("LibraryWatcher.scan_requested").pipe(Effect.annotateLogs({ reason })),
        ),
        Effect.catchTag("BackendError", (error) =>
          Effect.logWarning("LibraryWatcher.request_failed", error),
        ),
      );

    const onChange = folderChanges(library.path).pipe(
      Stream.debounce(DEBOUNCE),
      Stream.runForEach(() => requestScan("change")),
      Effect.catchTag("WatchError", (error) =>
        Effect.logWarning("LibraryWatcher.watch_unavailable", error),
      ),
    );

    const periodic = requestScan("periodic").pipe(
      Effect.repeat(Schedule.spaced(config.rescanInterval)),
    );

    yield* Effect.all([onChange, periodic], { concurrency: 2, discard: true });
  },
  (effect, library) => effect.pipe(Effect.annotateLogs({ libraryId: library.id })),
);

/** Watches every library for the lifetime of the layer, following libraries as they change. */
export const layer: Layer.Layer<never, never, MediaBackend | MediaConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend;
    const config = yield* MediaConfig;
    const watchers = yield* FiberMap.make<string>();
    const active = yield* Ref.make<ReadonlySet<string>>(new Set());

    const sync = Effect.fn("LibraryWatcher.sync")(function* (
      libraries: ReadonlyArray<LibraryFolder>,
    ) {
      const wanted = new Map(
        libraries.map((library) => [`${library.id}:${library.path}`, library]),
      );

      const previous = yield* Ref.get(active);

      for (const key of previous) {
        if (!wanted.has(key)) yield* FiberMap.remove(watchers, key);
      }

      for (const [key, library] of wanted) {
        yield* FiberMap.run(
          watchers,
          key,
          watchLibrary(library).pipe(
            Effect.provideService(MediaBackend, backend),
            Effect.provideService(MediaConfig, config),
          ),
          { onlyIfMissing: true },
        );
      }

      yield* Ref.set(active, new Set(wanted.keys()));
    });

    yield* backend.libraries.pipe(
      Stream.runForEach(sync),
      Effect.tapError((error) => Effect.logWarning("LibraryWatcher.subscription_lost", error)),
      Effect.retry(resubscribeSchedule),
      Effect.forkScoped,
    );
  }),
);
