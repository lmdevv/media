import { type TrickplayVersion, trickplayVersion } from "@media/contracts/trickplay";
import { Effect, FileSystem, Match } from "effect";
import type { Duration } from "effect";

import { JobFailed } from "../core/core-jobs.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import type { ResolvedMediaFile } from "../playback/file-resolver.ts";
import { generate } from "./trickplay-generator.ts";
import type * as TrickplayStore from "./trickplay-store.ts";

/** `n noun`, with the noun plural unless n is 1. */
export const count = (amount: number, noun: string): string =>
  `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;

type GenerateError = Effect.Error<ReturnType<typeof generate>>;

/** How a thumbnail build's failure ends its job. */
export const generateFailure = Match.type<
  GenerateError | TrickplayStore.TrickplayStorageFailed | JobFailed
>().pipe(
  Match.tagsExhaustive({
    JobFailed: (error) => error,
    TrickplayUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    MediaToolFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    TrickplayStorageFailed: (error) => new JobFailed({ message: error.message, retry: true }),
  }),
);

/** The size, change time, and thumbnail version of the file at `path` now. */
export const onDisk = Effect.fn("TrickplayJob.onDisk")(function* (path: string) {
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
