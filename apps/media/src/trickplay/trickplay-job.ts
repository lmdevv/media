import { type TrickplayVersion, trickplayVersion } from "@media/contracts/trickplay";
import { Bytes, EpochMillis } from "@media/contracts/units";
import { Clock, Effect, FileSystem, Match } from "effect";
import type { Duration, Path } from "effect";

import * as MediaBackend from "../convex/media-backend.ts";
import { JobFailed, type JobHandler } from "../jobs/job-worker.ts";
import * as MediaConfig from "../media-config.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import type * as MediaTools from "../media/media-tools.ts";
import type * as FileResolver from "../playback/file-resolver.ts";
import { type ResolvedMediaFile, resolveInsideRoots } from "../playback/file-resolver.ts";
import { generate } from "./trickplay-generator.ts";
import * as TrickplayStore from "./trickplay-store.ts";

const count = (amount: number, noun: string): string =>
  `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;

type GenerateError = Effect.Error<ReturnType<typeof generate>>;

const generateFailure = Match.type<
  GenerateError | TrickplayStore.TrickplayStorageFailed | JobFailed
>().pipe(
  Match.tagsExhaustive({
    JobFailed: (error) => error,
    TrickplayUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    MediaToolFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    TrickplayStorageFailed: (error) => new JobFailed({ message: error.message, retry: true }),
  }),
);

const onDisk = Effect.fn("TrickplayJob.onDisk")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  const info = yield* fs
    .stat(path)
    .pipe(
      Effect.mapError(() => new JobFailed({ message: "The file could not be read", retry: true })),
    );

  const sizeBytes = Number(info.size);
  const modifiedAt = modifiedAtMs(info);

  return { sizeBytes, modifiedAt, version: trickplayVersion(sizeBytes, modifiedAt) };
});

/**
 * Builds `file`'s sheets as `version`, the contents read before, into a folder, then reads the
 * file again: one replaced meanwhile may have fed ffmpeg other frames, so its sheets are dropped
 * and the job tries again.
 */
export const build =
  (file: ResolvedMediaFile, version: TrickplayVersion, interval: Duration.Duration) =>
  (folder: string) =>
    generate(file, version, interval, folder).pipe(
      Effect.tap(() =>
        onDisk(file.path).pipe(
          Effect.filterOrFail(
            (now) => now.version === version,
            () =>
              new JobFailed({
                message: "The file changed while its thumbnails were made",
                retry: true,
              }),
          ),
        ),
      ),
    );

/** The trickplay job handler, or none with `TRICKPLAY=off`, so the jobs wait for a service that runs them. */
export const handlers: Effect.Effect<
  ReadonlyArray<JobHandler>,
  never,
  | MediaBackend.Service
  | MediaConfig.Service
  | FileResolver.Service
  | TrickplayStore.Service
  | MediaTools.Service
  | FileSystem.FileSystem
  | Path.Path
> = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const config = yield* MediaConfig.Service;
  const store = yield* TrickplayStore.Service;

  const context = yield* Effect.context<
    | MediaConfig.Service
    | FileResolver.Service
    | MediaTools.Service
    | FileSystem.FileSystem
    | Path.Path
  >();

  const { interval, concurrency, enabled } = config.trickplay;

  if (!enabled) return [];

  const handler = {
    kind: "trickplay",
    concurrency,
    run: Effect.fn("TrickplayJob.run")(function* (claim, workerId, reportProgress) {
      const { job } = claim;

      if (job.payload.kind !== "trickplay") {
        return yield* new JobFailed({ message: "This is not a trickplay job", retry: false });
      }

      const { fileId } = job.payload;

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

      yield* reportProgress({ done: 0, total: 1, message: "Making thumbnails" });

      const started = yield* Clock.currentTimeMillis;

      const manifest = yield* store
        .publish(fileId, version, build(file, version, interval))
        .pipe(Effect.mapError(generateFailure));

      yield* backend
        .call("mediaService.recordTrickplay", {
          jobId: job.id,
          workerId,
          fileId,
          sizeBytes: Bytes.make(sizeBytes),
          mtimeMs: EpochMillis.make(Math.trunc(modifiedAt)),
          manifest,
        })
        .pipe(Effect.mapError((error) => new JobFailed({ message: error.message, retry: true })));

      yield* reportProgress({ done: 1, total: 1, message: null });

      const seconds = (((yield* Clock.currentTimeMillis) - started) / 1000).toFixed(1);

      return `${count(manifest.thumbnailCount, "thumbnail")} on ${count(manifest.sheetCount, "sheet")} in ${seconds} s`;
    }, Effect.provide(context)),
  } satisfies JobHandler;

  return [handler];
});
