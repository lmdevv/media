import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import * as MediaConfig from "./media-config.ts";
import { modifiedAtMs } from "./platform/file-info.ts";

/** What one prune did. */
interface PruneSummary {
  readonly removedFiles: number;
  readonly removedBytes: number;
  /** The bytes left in the caches, protected files included. */
  readonly keptBytes: number;
}

interface CacheFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

/** The caches under `DATA_DIR`, kept within `CACHE_MAX_MB`. */
export interface Interface {
  /**
   * Keeps the files at `paths` through every prune until the scope closes, even past the bound,
   * which they count toward. A prune checks this at the moment it would remove each file, so a
   * file protected after the prune listed it stays too. Returns once each file is protected or,
   * when a prune was already removing it, gone. The paths need not exist yet.
   */
  readonly protect: (paths: ReadonlyArray<string>) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Removes abandoned temporary files, then the least recently used files until the rest fit the
   * bound, and answers what that prune did. One prune runs at a time: a call made while one runs
   * waits for the next, which starts when that one ends and answers every call made meanwhile.
   */
  readonly prune: Effect.Effect<PruneSummary>;
}

/** The cache pruner. */
export class Service extends Context.Service<Service, Interface>()("@media/server/CachePruner") {}

const PRUNE_EVERY = Duration.hours(1);

const ABANDONED_AFTER = Duration.hours(1);

const MARK_AFTER = Duration.days(1);

const NOTHING_PRUNED: PruneSummary = { removedFiles: 0, removedBytes: 0, keptBytes: 0 };

/**
 * Marks `file` as used now, for the least-recently-used order, by its modification time. A file
 * marked within the last day is left alone: the order only needs that accuracy, and a poster
 * grid would otherwise write metadata for every image on every load.
 */
export const markUsed = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const info = yield* fs.stat(file);

  if (now - modifiedAtMs(info) >= Duration.toMillis(MARK_AFTER)) {
    yield* fs.utimes(file, now / 1000, now / 1000);
  }
});

/** The cache folders under `dataDir`. */
export const cacheDirectories = (dataDir: string, path: Path.Path): ReadonlyArray<string> => [
  path.join(dataDir, "cache"),
  path.join(dataDir, "artwork"),
];

const listFiles = Effect.fnUntraced(function* (roots: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const perRoot = yield* Effect.forEach(roots, (root) =>
    fs.readDirectory(root, { recursive: true }).pipe(
      Effect.orElseSucceed(() => []),
      Effect.flatMap((names) =>
        Effect.forEach(
          names,
          (name) =>
            fs.stat(path.join(root, name)).pipe(
              Effect.map((info) =>
                info.type === "File"
                  ? Option.some<CacheFile>({
                      path: path.join(root, name),
                      size: Number(info.size),
                      modifiedAt: modifiedAtMs(info),
                    })
                  : Option.none(),
              ),
              Effect.orElseSucceed(() => Option.none<CacheFile>()),
            ),
          { concurrency: 16 },
        ),
      ),
    ),
  );

  return perRoot.flat().flatMap((file) => (Option.isSome(file) ? [file.value] : []));
});

/**
 * The asks so far, numbered from 1; `done`, the last ask a finished prune answered, so asks at or
 * below it read `last`, what that prune did.
 */
interface Runs {
  readonly asked: number;
  readonly done: number;
  readonly last: PruneSummary;
}

/**
 * The pruner of the caches under `roots`, keeping them within `maxBytes`. It runs the prunes asked
 * of it on one fiber in the scope.
 */
export const make = Effect.fn("CachePruner.make")(function* (
  roots: ReadonlyArray<string>,
  maxBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /** Guards `held` and `removing`; taken only for steps that do not wait. */
  const lock = yield* Semaphore.make(1);
  /** How many holders protect each path. */
  const held = new Map<string, number>();
  /** The removal under way of each path, done once the file is gone or could not be removed. */
  const removing = new Map<string, Deferred.Deferred<void>>();
  const runs = yield* SubscriptionRef.make<Runs>({ asked: 0, done: 0, last: NOTHING_PRUNED });

  // Only the registration is uninterruptible; waiting out a removal under way is not.
  const protect = (paths: ReadonlyArray<string>): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      lock.withPermits(1)(
        Effect.sync(() =>
          paths.flatMap((target) => {
            held.set(target, (held.get(target) ?? 0) + 1);
            const underway = removing.get(target);

            return underway === undefined ? [] : [underway];
          }),
        ),
      ),
      () =>
        lock.withPermits(1)(
          Effect.sync(() => {
            for (const target of paths) {
              const holders = (held.get(target) ?? 0) - 1;

              if (holders > 0) held.set(target, holders);
              else held.delete(target);
            }
          }),
        ),
    ).pipe(
      Effect.flatMap((underway) => Effect.forEach(underway, Deferred.await, { discard: true })),
    );

  /**
   * Removes `file` unless it is protected at that moment: `removed`, `kept`, or `failed`. The
   * check and the mark of a removal under way are one step under `lock`, and the mark always
   * clears, interrupted or not.
   */
  const removeUnlessProtected = (file: CacheFile) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const underway = yield* Deferred.make<void>();

        const started = yield* lock.withPermits(1)(
          Effect.sync(() => {
            if (held.has(file.path)) return false;
            removing.set(file.path, underway);

            return true;
          }),
        );

        if (!started) return "kept" as const;

        return yield* restore(fs.remove(file.path)).pipe(
          Effect.as("removed" as const),
          Effect.orElseSucceed(() => "failed" as const),
          Effect.ensuring(
            lock
              .withPermits(1)(Effect.sync(() => removing.delete(file.path)))
              .pipe(Effect.andThen(Deferred.succeed(underway, undefined))),
          ),
        );
      }),
    );

  const once = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const files = yield* listFiles(roots).pipe(Effect.provideService(Path.Path, path));
    const protectedNow = yield* lock.withPermits(1)(Effect.sync(() => new Set(held.keys())));
    const abandonedBefore = now - Duration.toMillis(ABANDONED_AFTER);

    const abandoned = files.filter(
      (file) => path.basename(file.path).includes(".part") && file.modifiedAt < abandonedBefore,
    );

    const live = files
      .filter((file) => !abandoned.includes(file))
      .toSorted((left, right) => right.modifiedAt - left.modifiedAt);

    const kept = new Set(live.filter((file) => protectedNow.has(file.path)));
    let keptBytes = [...kept].reduce((total, file) => total + file.size, 0);
    const expired: Array<CacheFile> = [];

    for (const file of live) {
      if (kept.has(file)) continue;

      if (keptBytes + file.size <= maxBytes) keptBytes += file.size;
      else expired.push(file);
    }

    // One at a time: a background prune need not be quick, and a protection taken meanwhile then
    // spares every file but the one being removed.
    const outcomes = yield* Effect.forEach([...abandoned, ...expired], (file) =>
      removeUnlessProtected(file).pipe(Effect.map((outcome) => ({ file, outcome }))),
    );

    const removed = outcomes.filter(({ outcome }) => outcome === "removed");

    return {
      removedFiles: removed.length,
      removedBytes: removed.reduce((total, { file }) => total + file.size, 0),
      keptBytes: outcomes.reduce(
        (total, { file, outcome }) => (outcome === "removed" ? total : total + file.size),
        keptBytes,
      ),
    } satisfies PruneSummary;
  }).pipe(
    Effect.tap((summary) =>
      summary.removedFiles === 0
        ? Effect.void
        : Effect.logInfo("CachePruner.pruned").pipe(Effect.annotateLogs({ ...summary })),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.withSpan("CachePruner.run"),
  );

  yield* SubscriptionRef.changes(runs).pipe(
    Stream.filter(({ asked, done }) => asked > done),
    Stream.runHead,
    Effect.andThen(SubscriptionRef.get(runs)),
    Effect.flatMap(({ asked }) =>
      once.pipe(
        // Every caller waits on this fiber, so a prune that dies is logged and answered as empty
        // rather than leaving them, and the protections they hold, waiting for ever.
        Effect.catchDefect((defect) =>
          Effect.logError("CachePruner.prune_failed", defect).pipe(Effect.as(NOTHING_PRUNED)),
        ),
        Effect.flatMap((last) =>
          SubscriptionRef.update(runs, (current) => ({ ...current, done: asked, last })),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const prune = Effect.gen(function* () {
    const asked = yield* SubscriptionRef.modify(runs, (current) => [
      current.asked + 1,
      { ...current, asked: current.asked + 1 },
    ]);

    const ran = yield* SubscriptionRef.changes(runs).pipe(
      Stream.filter(({ done }) => done >= asked),
      Stream.runHead,
    );

    return Option.match(ran, { onNone: () => NOTHING_PRUNED, onSome: ({ last }) => last });
  }).pipe(Effect.withSpan("CachePruner.prune"));

  return Service.of({ protect, prune });
});

/** Prunes the caches under `DATA_DIR` at startup, every hour, and when asked. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const path = yield* Path.Path;
    const pruner = yield* make(cacheDirectories(config.dataDir, path), config.cacheMaxBytes);

    yield* pruner.prune.pipe(Effect.repeat(Schedule.spaced(PRUNE_EVERY)), Effect.forkScoped);

    return pruner;
  }),
);
