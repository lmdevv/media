import type { MediaFileId } from "@media/contracts/ids";
import { FileResolverUnavailable, MediaFileNotFound } from "@media/contracts/media-playback";
import type { CallError } from "@media/sdk/effect";
import { Cache, Duration, Effect, Exit, FileSystem, Layer, Match, Option } from "effect";

import * as FileResolver from "../playback/file-resolver.ts";
import { isNotFound, modifiedAtMs } from "../platform/file-info.ts";
import { relativeTo, toResolvedMediaFile } from "./catalog-records.ts";
import * as MediaBackend from "./media-backend.ts";

const CACHE_TTL = Duration.seconds(30);

const make = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const fs = yield* FileSystem.FileSystem;

  const lookup = Effect.fn("ConvexFileResolver.lookup")(function* (fileId: MediaFileId) {
    const resolved = yield* backend.call("mediaService.resolveFile", { fileId }).pipe(
      Effect.mapError(
        Match.type<CallError>().pipe(
          Match.tags({
            NotFound: () => new MediaFileNotFound({ fileId }),
            InvalidArgs: () => new MediaFileNotFound({ fileId }),
          }),
          Match.orElse(() => new FileResolverUnavailable({ cause: "The catalog did not answer" })),
        ),
      ),
    );

    if (resolved.missing) return yield* new MediaFileNotFound({ fileId });

    const insideLibrary = resolved.roots.some((root) =>
      Option.isSome(relativeTo(root, resolved.path)),
    );

    if (!insideLibrary) {
      yield* Effect.logError("ConvexFileResolver.path_outside_library").pipe(
        Effect.annotateLogs({ fileId }),
      );

      return yield* new MediaFileNotFound({ fileId });
    }

    const info = yield* fs.stat(resolved.path).pipe(
      Effect.tapError((error) =>
        isNotFound(error)
          ? Effect.void
          : Effect.logWarning("ConvexFileResolver.file_unreadable", error).pipe(
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

/** The resolver over the Convex connection. */
export const layer: Layer.Layer<
  FileResolver.Service,
  never,
  MediaBackend.Service | FileSystem.FileSystem
> = Layer.effect(FileResolver.Service, make);
