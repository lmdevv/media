import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import { TestClock } from "effect/testing";

import * as CachePruner from "./cache-pruner.ts";
import * as DiskCache from "./disk-cache.ts";
import { testConfigLayer } from "./testing/test-config.ts";

const withDataDir = <A, E, R>(use: (dataDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "movies-cache-" });

    return yield* use(dataDir);
  });

const cacheIn = (dataDir: string) =>
  Layer.build(DiskCache.layer.pipe(Layer.provide(testConfigLayer({ DATA_DIR: dataDir })))).pipe(
    Effect.map((context) => Context.get(context, DiskCache.Service)),
  );

describe("disk cache", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("reads what it wrote until it is older than the caller allows", () =>
      withDataDir((dataDir) =>
        Effect.gen(function* () {
          const cache = yield* cacheIn(dataDir);

          assert.isTrue(Option.isNone(yield* cache.read("tmdb", "/movie/1", Duration.days(1))));
          yield* cache.write("tmdb", "/movie/1", '{"id":1}');

          assert.deepStrictEqual(
            yield* cache.read("tmdb", "/movie/1", Duration.days(1)),
            Option.some('{"id":1}'),
          );
          assert.isTrue(Option.isNone(yield* cache.read("tmdb", "/movie/2", Duration.days(1))));
          assert.isTrue(Option.isNone(yield* cache.read("other", "/movie/1", Duration.days(1))));

          yield* TestClock.adjust(Duration.days(2));

          assert.isTrue(Option.isNone(yield* cache.read("tmdb", "/movie/1", Duration.days(1))));
          assert.isTrue(Option.isSome(yield* cache.read("tmdb", "/movie/1", Duration.days(3))));
        }),
      ),
    );

    it.effect("treats a corrupt entry as a miss and replaces it on the next write", () =>
      withDataDir((dataDir) =>
        Effect.gen(function* () {
          const cache = yield* cacheIn(dataDir);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* cache.write("subtitles", "track", "WEBVTT\n");
          const folder = path.join(dataDir, "cache", "subtitles");
          const [entry = ""] = yield* fs.readDirectory(folder);

          yield* fs.writeFileString(path.join(folder, entry), "{not json");

          assert.isTrue(Option.isNone(yield* cache.read("subtitles", "track", Duration.days(1))));

          yield* cache.write("subtitles", "track", "WEBVTT\n\nagain");

          assert.deepStrictEqual(
            yield* cache.read("subtitles", "track", Duration.days(1)),
            Option.some("WEBVTT\n\nagain"),
          );
        }),
      ),
    );

    it.effect("prunes the least recently used files and abandoned writes down to the cap", () =>
      withDataDir((dataDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = path.join(dataDir, "movies.parts");
          const roots = CachePruner.cacheDirectories(root, path);
          const hour = 60 * 60;
          const now = 10 * 24 * hour;

          yield* TestClock.setTime(now * 1000);

          const file = Effect.fnUntraced(function* (
            relative: string,
            kilobytes: number,
            hoursAgo: number,
          ) {
            const target = path.join(root, relative);

            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFile(target, new Uint8Array(kilobytes * 1024));
            yield* fs.utimes(target, now - hoursAgo * hour, now - hoursAgo * hour);

            return target;
          });

          const oldest = yield* file("cache/tmdb/a.json", 40, 72);
          const older = yield* file("artwork/w342/b.jpg", 40, 48);
          const recent = yield* file("cache/keyframes/c.json", 40, 2);
          const newest = yield* file("artwork/originals/d.jpg", 40, 0);
          const abandoned = yield* file("cache/tmdb/e.json.1x.part", 1, 3);
          const writing = yield* file("artwork/w185/f.jpg.2y.part.jpg", 1, 0);

          const pruner = yield* CachePruner.make(roots, 90 * 1024);
          const summary = yield* pruner.prune;

          const remaining = yield* Effect.forEach(
            [oldest, older, recent, newest, abandoned, writing],
            (target) => fs.exists(target),
          );

          assert.deepStrictEqual(remaining, [false, false, true, true, false, true]);
          assert.strictEqual(summary.removedFiles, 3);
          assert.strictEqual(summary.keptBytes, 81 * 1024);

          assert.strictEqual((yield* pruner.prune).removedFiles, 0);

          const kept = yield* file("cache/music/fmp4-aac/g.m4a", 100, 1);

          const keptSummary = yield* Effect.scoped(
            pruner.protect([kept]).pipe(Effect.andThen(pruner.prune)),
          );

          const afterKeep = yield* Effect.forEach([recent, newest, kept], (target) =>
            fs.exists(target),
          );

          assert.deepStrictEqual(afterKeep, [false, false, true]);
          assert.strictEqual(keptSummary.keptBytes, 100 * 1024);
        }),
      ),
    );

    it.effect("keeps an entry the cache just read, ahead of older unread ones", () =>
      withDataDir((dataDir) =>
        Effect.gen(function* () {
          const cache = yield* cacheIn(dataDir);
          const path = yield* Path.Path;

          yield* TestClock.setTime(Date.now());
          yield* cache.write("tmdb", "first", "x".repeat(10_000));
          yield* TestClock.adjust(Duration.days(2));
          yield* cache.write("tmdb", "second", "x".repeat(10_000));
          yield* TestClock.adjust(Duration.days(2));
          yield* cache.read("tmdb", "first", Duration.days(30));
          yield* (yield* CachePruner.make(CachePruner.cacheDirectories(dataDir, path), 15_000))
            .prune;

          assert.isTrue(Option.isSome(yield* cache.read("tmdb", "first", Duration.days(30))));
          assert.isTrue(Option.isNone(yield* cache.read("tmdb", "second", Duration.days(30))));
        }),
      ),
    );
  });
});
