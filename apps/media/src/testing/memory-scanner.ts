/**
 * The library scanner over the in-memory library, with the fixture workspace as its only root and
 * no metadata provider, for tests that scan fixture files.
 */
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Path } from "effect";
import { FetchHttpClient } from "effect/http";

import type { LibraryId } from "@media/contracts/ids";
import * as DiskCache from "../disk-cache.ts";
import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import * as Omdb from "../metadata/omdb.ts";
import * as Tmdb from "../metadata/tmdb.ts";
import * as FixtureWorkspace from "./fixture-workspace.ts";
import { testConfigLayer } from "./test-config.ts";

/** The scanner and what it scans with, each in the context for tests to use. */
export const scannerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* FixtureWorkspace.Service;
    const path = yield* Path.Path;

    const config = testConfigLayer({
      LIBRARY_ROOTS: workspace.root,
      DATA_DIR: path.join(workspace.root, "data"),
    });

    return LibraryScanner.layer.pipe(
      Layer.provideMerge(MemoryLibrary.layer),
      Layer.provideMerge(MetadataResolver.layer),
      Layer.provide(Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none()))),
      Layer.provide(Omdb.layerWithOptions(Omdb.defaultOptions(Option.none()))),
      Layer.provide(DiskCache.layer),
      Layer.provideMerge(MediaTools.layer),
      Layer.provideMerge(config),
    );
  }),
).pipe(
  Layer.provideMerge(FixtureWorkspace.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

/** The files library `libraryId` holds, by path relative to their folder. */
export const scanned = Effect.fn(function* (libraryId: LibraryId) {
  const library = yield* MemoryLibrary.Service;
  const files = yield* library.files(libraryId);

  return new Map(files.map((file) => [file.record.relativePath, file]));
});

/** The stored record of `relativePath` in library `libraryId`, which must exist. */
export const storedOf = Effect.fn(function* (libraryId: LibraryId, relativePath: string) {
  const stored = (yield* scanned(libraryId)).get(relativePath)?.record;

  if (stored === undefined) return yield* Effect.die(new Error(`${relativePath} is not stored`));

  return stored;
});
