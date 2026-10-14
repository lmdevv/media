/**
 * Requests scans when library folders change. Each library gets a recursive `fs.watch`, debounced
 * so a burst of changes becomes one scan, plus a periodic rescan for file systems that send no
 * change events (SMB, NFS). The first periodic scan runs at startup to catch changes made while
 * the service was down. Convex collapses requests into the library's pending or running job.
 *
 * A watch that fails to start (the folder is missing, or the system's inotify limits are reached)
 * or stops later is started again with backoff, and requests a scan once it runs again, for the
 * changes it missed meanwhile.
 */
import { Cause, Effect, FiberMap, Layer, Queue, Ref, Schedule, Schema, Stream } from "effect";

import { type LibraryFolder, MediaBackend, resubscribeSchedule } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";
import { watchTree } from "./platform/node-watch.ts";

const DEBOUNCE = "5 seconds";

/** Backoff for starting a failed watch again: exponential from one second, capped at a minute. */
const RESTART_SCHEDULE = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("1 minute"),
]);

const errorCode = (cause: unknown): string =>
  cause instanceof Error && "code" in cause ? String(cause.code) : "";

/**
 * The folder watcher failed to start or stopped. Periodic rescans continue regardless. When the
 * system's inotify limits are the reason, the message says which `sysctl` raises them.
 */
export class WatchError extends Schema.TaggedError<WatchError>()("WatchError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const failed = `Folder watch failed: ${this.path}`;
    const meanwhile = "Changes are found by the periodic rescan until the watch starts again.";

    const code = errorCode(this.cause);

    if (code === "ENOSPC") {
      return (
        `${failed}: the system limit on watched folders (inotify watches) is reached. ` +
        "Raise it on the host with `sysctl -w fs.inotify.max_user_watches=524288` and keep it " +
        "in /etc/sysctl.d (on NixOS, `boot.kernel.sysctl`). " +
        meanwhile
      );
    }

    if (code === "EMFILE") {
      return (
        `${failed}: the system limit on folder watchers (inotify instances) is reached. ` +
        "Raise it on the host with `sysctl -w fs.inotify.max_user_instances=1024` and keep it " +
        "in /etc/sysctl.d (on NixOS, `boot.kernel.sysctl`). " +
        meanwhile
      );
    }

    return `${failed}. ${meanwhile}`;
  }
}

const isHidden = (relativePath: string): boolean =>
  relativePath.split(/[\\/]/).some((segment) => segment.startsWith("."));

/**
 * Emits once for every visible change under `path`, and once as soon as the watch runs when
 * `started` (run then) says so. Fails when the watch cannot start or stops.
 */
const folderChanges = (
  path: string,
  started: Effect.Effect<boolean>,
): Stream.Stream<void, WatchError> =>
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
    ).pipe(
      Effect.andThen(started),
      Effect.tap((announce) => (announce ? Queue.offer(queue, undefined) : Effect.void)),
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

    // Failures since the watch last ran: a watch that starts again after one scans for what it
    // missed, and only the first failure in a row is a warning.
    const failures = yield* Ref.make(0);

    const started = Ref.getAndSet(failures, 0).pipe(Effect.map((missed) => missed > 0));

    const onChange = folderChanges(library.path, started).pipe(
      Stream.debounce(DEBOUNCE),
      Stream.runForEach(() => requestScan("change")),
      Effect.tapError((error) =>
        Ref.getAndUpdate(failures, (count) => count + 1).pipe(
          Effect.flatMap((before) =>
            before === 0
              ? Effect.logWarning("LibraryWatcher.watch_unavailable", error)
              : Effect.logDebug("LibraryWatcher.watch_unavailable", error),
          ),
        ),
      ),
      Effect.retry(RESTART_SCHEDULE),
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
