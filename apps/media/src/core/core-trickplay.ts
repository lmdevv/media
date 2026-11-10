import { serverFunctions, TRICKPLAY_VERSIONS_MAX } from "@media/contracts/server-functions";
import { Bytes, EpochMillis } from "@media/contracts/units";
import { Array as Arr, Clock, Duration, Effect, Layer, Schedule } from "effect";
import type { FileSystem, Path } from "effect";

import { JobFailed } from "../jobs/job-worker.ts";
import * as MediaConfig from "../media-config.ts";
import type * as MediaTools from "../media/media-tools.ts";
import type * as FileResolver from "../playback/file-resolver.ts";
import { resolveInsideRoots } from "../playback/file-resolver.ts";
import { build, count, generateFailure, onDisk } from "../trickplay/trickplay-job.ts";
import * as TrickplayStore from "../trickplay/trickplay-store.ts";
import * as CoreJobs from "./core-jobs.ts";
import * as CoreSession from "./core-session.ts";

const CHANGED =
  "The file changed since this job was queued; a scan queues one for its new contents";

/**
 * Scrub thumbnails on the core, or no handler with `TRICKPLAY=off`. A job carries the contents it
 * is for (`size:mtime`): the server builds only when the file on disk still has them and records
 * the result against them, so the core ignores a result for older contents (ADR 0012).
 */
export const handlers = Effect.gen(function* () {
  const session = yield* CoreSession.Service;
  const config = yield* MediaConfig.Service;
  const store = yield* TrickplayStore.Service;

  const context = yield* Effect.context<
    | MediaConfig.Service
    | FileResolver.Service
    | MediaTools.Service
    | FileSystem.FileSystem
    | Path.Path
  >();

  const { interval, enabled } = config.trickplay;

  if (!enabled) return [];

  return [
    CoreJobs.handler({
      kind: "movies.trickplay",
      run: Effect.fn("CoreTrickplay.run")(function* (job, report) {
        const { lease, payload } = job;
        const { fileId } = payload;

        const file = yield* resolveInsideRoots(fileId, { sidecars: false }).pipe(
          Effect.catchTags({
            MediaFileNotFound: () =>
              Effect.fail(
                new JobFailed({ message: "This file is missing or was removed", retry: false }),
              ),
            FileResolverUnavailable: (error) =>
              Effect.fail(new JobFailed({ message: error.message, retry: true })),
          }),
        );

        const { sizeBytes, modifiedAt, version } = yield* onDisk(file.path);
        const mtimeMs = Math.trunc(modifiedAt);

        if (`${String(sizeBytes)}:${String(mtimeMs)}` !== payload.revision) return CHANGED;

        yield* report({ done: 0, total: 1, message: "Making thumbnails" });

        const started = yield* Clock.currentTimeMillis;

        const manifest = yield* store
          .publish(fileId, version, build(file, version, interval))
          .pipe(Effect.mapError(generateFailure));

        yield* session
          .call(serverFunctions.recordTrickplay, {
            lease,
            fileId,
            sizeBytes: Bytes.make(sizeBytes),
            mtimeMs: EpochMillis.make(mtimeMs),
            manifest,
          })
          .pipe(
            Effect.mapError((error) => new JobFailed({ message: error.message, retry: true })),
            Effect.flatMap(CoreJobs.held),
          );

        yield* report({ done: 1, total: 1 });

        const seconds = (((yield* Clock.currentTimeMillis) - started) / 1000).toFixed(1);

        return `${count(manifest.thumbnailCount, "thumbnail")} on ${count(manifest.sheetCount, "sheet")} in ${seconds} s`;
      }, Effect.provide(context)),
    }),
  ];
});

const FIRST_SWEEP_AFTER = Duration.minutes(1);

/** Deletes thumbnails no file of the core still uses, every reconcile interval. */
export const sweepLayer: Layer.Layer<
  never,
  never,
  CoreSession.Service | MediaConfig.Service | TrickplayStore.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const session = yield* CoreSession.Service;
    const config = yield* MediaConfig.Service;
    const store = yield* TrickplayStore.Service;

    const versions = (fileIds: ReadonlyArray<string>) =>
      Effect.forEach(Arr.chunksOf(fileIds, TRICKPLAY_VERSIONS_MAX), (chunk) =>
        session.call(serverFunctions.trickplayVersions, { fileIds: chunk }),
      ).pipe(Effect.map((pages) => new Map(pages.flat().map((row) => [row.fileId, row.version]))));

    const sweep = store.sweep(versions).pipe(
      Effect.tap((removed) =>
        removed === 0
          ? Effect.void
          : Effect.logInfo("CoreTrickplay.swept").pipe(Effect.annotateLogs({ removed })),
      ),
      Effect.catch((error) => Effect.logWarning("CoreTrickplay.sweep_skipped", error)),
    );

    yield* sweep.pipe(
      Effect.delay(FIRST_SWEEP_AFTER),
      Effect.repeat(Schedule.spaced(config.reconcileInterval)),
      Effect.forkScoped,
    );
  }),
);
