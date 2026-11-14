import { Clock, Duration, Effect, FileSystem, Layer, Option, Path, Schedule } from "effect";

import * as MediaConfig from "./media-config.ts";
import { modifiedAtMs } from "./platform/file-info.ts";

interface PruneSummary {
  readonly removedFiles: number;
  readonly removedBytes: number;
  readonly keptBytes: number;
}

interface CacheFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

const PRUNE_EVERY = Duration.hours(1);

const ABANDONED_AFTER = Duration.hours(1);

const MARK_AFTER = Duration.days(1);

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
 * Removes abandoned temporary files under `roots`, then the oldest files until the rest take at
 * most `maxBytes`. The files at the paths in `keep` stay, even past `maxBytes`, and count toward it.
 */
export const prune = Effect.fn("CachePruner.prune")(function* (
  roots: ReadonlyArray<string>,
  maxBytes: number,
  keep: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const files = yield* listFiles(roots);
  const abandonedBefore = now - Duration.toMillis(ABANDONED_AFTER);

  const abandoned = files.filter(
    (file) => path.basename(file.path).includes(".part") && file.modifiedAt < abandonedBefore,
  );

  const live = files
    .filter((file) => !abandoned.includes(file))
    .toSorted((left, right) => right.modifiedAt - left.modifiedAt);

  const kept = new Set(live.filter((file) => keep.includes(file.path)));
  let keptBytes = [...kept].reduce((total, file) => total + file.size, 0);
  const expired: Array<CacheFile> = [];

  for (const file of live) {
    if (kept.has(file)) continue;

    if (keptBytes + file.size <= maxBytes) keptBytes += file.size;
    else expired.push(file);
  }

  const removed = yield* Effect.forEach(
    [...abandoned, ...expired],
    (file) =>
      fs.remove(file.path).pipe(
        Effect.as(file.size),
        Effect.orElseSucceed(() => 0),
      ),
    { concurrency: 8 },
  );

  return {
    removedFiles: removed.filter((size) => size > 0).length,
    removedBytes: removed.reduce((total, size) => total + size, 0),
    keptBytes,
  } satisfies PruneSummary;
});

/** Prunes the caches at startup and every hour for the lifetime of the layer. */
export const layer: Layer.Layer<
  never,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const path = yield* Path.Path;
    const roots = cacheDirectories(config.dataDir, path);

    yield* prune(roots, config.cacheMaxBytes).pipe(
      Effect.tap((summary) =>
        summary.removedFiles === 0
          ? Effect.void
          : Effect.logInfo("CachePruner.pruned").pipe(Effect.annotateLogs({ ...summary })),
      ),
      Effect.repeat(Schedule.spaced(PRUNE_EVERY)),
      Effect.forkScoped,
    );
  }),
);
