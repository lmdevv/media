import type { MediaFileId } from "@media/contracts/ids";
import { FileResolverUnavailable, MediaFileNotFound } from "@media/contracts/media-playback";
import { serverFunctions } from "@media/contracts/server-functions";
import { Cache, Duration, Effect, Exit, FileSystem, Layer, Option, Predicate } from "effect";

import { relativeTo, toResolvedMediaFile } from "../convex/catalog-records.ts";
import * as FileResolver from "../playback/file-resolver.ts";
import { isNotFound, modifiedAtMs } from "../platform/file-info.ts";
import * as CoreSession from "./core-session.ts";

const CACHE_TTL = Duration.seconds(30);

const make = Effect.gen(function* () {
  const session = yield* CoreSession.Service;
  const fs = yield* FileSystem.FileSystem;

  const lookup = Effect.fn("CoreFiles.lookup")(function* (fileId: MediaFileId) {
    const resolved = yield* session
      .call(serverFunctions.resolveFile, { fileId })
      .pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "NotFound") || Predicate.isTagged(error, "InvalidArgs")
            ? new MediaFileNotFound({ fileId })
            : new FileResolverUnavailable({ cause: "The catalog did not answer" }),
        ),
      );

    // The core answers null for a missing file and for one whose title is being purged.
    if (resolved === null || resolved.missing) return yield* new MediaFileNotFound({ fileId });

    const insideLibrary = resolved.roots.some((root) =>
      Option.isSome(relativeTo(root, resolved.path)),
    );

    if (!insideLibrary) {
      yield* Effect.logError("CoreFiles.path_outside_library").pipe(
        Effect.annotateLogs({ fileId }),
      );

      return yield* new MediaFileNotFound({ fileId });
    }

    const info = yield* fs.stat(resolved.path).pipe(
      Effect.tapError((error) =>
        isNotFound(error)
          ? Effect.void
          : Effect.logWarning("CoreFiles.file_unreadable", error).pipe(
              Effect.annotateLogs({ fileId }),
            ),
      ),
      Effect.mapError((error) =>
        isNotFound(error)
          ? new MediaFileNotFound({ fileId })
          : new FileResolverUnavailable({ cause: "The file could not be read" }),
      ),
    );

    return toResolvedMediaFile(resolved, Number(info.size), modifiedAtMs(info));
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 1024,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? CACHE_TTL : Duration.zero),
  });

  return FileResolver.Service.of({ resolve: (fileId) => Cache.get(cache, fileId) });
});

/** Resolves the files tickets name through the core's `movies/files:resolveFile`. */
export const layer: Layer.Layer<
  FileResolver.Service,
  never,
  CoreSession.Service | FileSystem.FileSystem
> = Layer.effect(FileResolver.Service, make);
