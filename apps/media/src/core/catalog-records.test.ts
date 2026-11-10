import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { LibraryId, MediaFileId } from "@media/contracts/ids";
import { ScannedItem } from "@media/contracts/models/scan";
import { Effect, Layer, Option, Path, Schema } from "effect";
import { it as plain } from "vitest";
import { FetchHttpClient } from "effect/http";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as DiskCache from "../disk-cache.ts";
import * as LibraryScanner from "../library/library-scanner.ts";
import { parseMediaPath } from "../library/media-naming.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import * as Omdb from "../metadata/omdb.ts";
import * as Tmdb from "../metadata/tmdb.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { testArtworkKeysLayer } from "../testing/test-tokens.ts";
import {
  matchKeyOf,
  toCatalogProbe,
  toResolvedMediaFile,
  toScannedItem,
  versionNameOf,
} from "./catalog-records.ts";

const hasFfmpeg = await ffmpegAvailable();

const recordsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* FixtureWorkspace.Service;
    const path = yield* Path.Path;

    const config = testConfigLayer({
      LIBRARY_ROOTS: workspace.root,
      DATA_DIR: path.join(workspace.root, "data"),
    });

    return Layer.mergeAll(LibraryScanner.layer, testArtworkKeysLayer).pipe(
      Layer.provideMerge(MemoryLibrary.layer),
      Layer.provide(MetadataResolver.layer),
      Layer.provide(Tmdb.layerWithOptions(Tmdb.defaultOptions(Option.none()))),
      Layer.provide(Omdb.layerWithOptions(Omdb.defaultOptions(Option.none()))),
      Layer.provide(DiskCache.layer),
      Layer.provide(MediaTools.layer),
      Layer.provide(config),
    );
  }),
).pipe(
  Layer.provideMerge(FixtureWorkspace.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

const decodeItem = Schema.decodeUnknownEffect(ScannedItem);

const named = (path: string) => versionNameOf(parseMediaPath(path));

describe("version names", () => {
  plain("names a movie file by its edition and its part, and an episode by neither", () => {
    assert.strictEqual(
      named("Heat (1995)/Heat (1995) {edition-Director's Cut}.mkv"),
      "Director's Cut",
    );
    assert.strictEqual(named("Heat (1995)/Heat (1995) - cd2.avi"), "Part 2");
    assert.strictEqual(
      named("Heat (1995)/Heat (1995) {edition-Extended} - part1.mkv"),
      "Extended · Part 1",
    );
    assert.isNull(named("Heat (1995)/Heat (1995).mkv"));
    assert.isNull(named("Show (2020)/Season 01/Show - S01E01.mkv"));
  });
});

describe.skipIf(!hasFfmpeg)("catalog records", () => {
  layer(recordsLayer, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect(
      "turns every scanned fixture into a valid Convex item and back into the same probe",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const scanner = yield* LibraryScanner.Service;
          const store = yield* MemoryLibrary.Service;
          const keys = yield* ArtworkKeys.Service;

          for (const [name, root] of [
            ["movies", library.moviesRoot],
            ["shows", library.showsRoot],
          ] as const) {
            const libraryId = LibraryId.make(name);
            const folder = { libraryId, root };

            yield* scanner.scan({ libraryId, root, mode: "full" });

            for (const stored of yield* store.files(libraryId)) {
              const item = yield* toScannedItem(folder, stored.record, keys.seal);

              if (Option.isNone(item)) continue;
              const decoded = yield* decodeItem(item.value);

              assert.strictEqual(decoded.file.path, `${root}/${stored.record.relativePath}`);

              const resolved = toResolvedMediaFile(
                {
                  fileId: MediaFileId.make("file"),
                  libraryId,
                  path: decoded.file.path,
                  roots: [root],
                  probe: decoded.file.probe,
                  externalSubtitles: decoded.file.externalSubtitles,
                  missing: false,
                },
                decoded.file.sizeBytes,
                decoded.file.mtimeMs,
              );

              assert.deepStrictEqual(
                toCatalogProbe(resolved.probe),
                toCatalogProbe(stored.record.probe),
                stored.record.relativePath,
              );
              assert.deepStrictEqual(
                resolved.subtitles.map((subtitle) => subtitle.path),
                stored.record.subtitles.map((subtitle) => `${root}/${subtitle.path}`),
              );
            }
          }
        }),
    );

    it.effect("keys titles by kind and provider ID, else by name and year", () =>
      Effect.sync(() => {
        const title = {
          kind: "movie" as const,
          title: "The  Matrix",
          year: 1999,
          genres: [],
          studios: [],
          countries: [],
          tags: [],
          ratings: {},
          recommendations: [],
          credits: [],
          sources: ["name" as const],
        };

        assert.strictEqual(matchKeyOf({ ...title, ids: { tmdb: "603" } }), "movie:tmdb:603");
        assert.strictEqual(
          matchKeyOf({ ...title, ids: { imdb: "tt0133093" } }),
          "movie:imdb:tt0133093",
        );
        assert.strictEqual(matchKeyOf({ ...title, ids: {} }), "movie:local:the matrix (1999)");
        assert.strictEqual(
          matchKeyOf({ ...title, kind: "show", ids: { tmdb: "603" } }),
          "show:tmdb:603",
        );
      }),
    );
  });
});
