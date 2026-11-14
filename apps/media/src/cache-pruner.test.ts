import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Path, Ref } from "effect";

import * as CachePruner from "./cache-pruner.ts";
import { listingHeldUntil, removalHeldUntil } from "./testing/held-file-system.ts";

const KIB = 1024;

/** Writes `kilobytes` of zeros at `target`, last changed `secondsAgo` seconds before now. */
const cacheFile = Effect.fnUntraced(function* (
  target: string,
  kilobytes: number,
  secondsAgo: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = Date.now() / 1000 - secondsAgo;

  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFile(target, new Uint8Array(kilobytes * KIB));
  yield* fs.utimes(target, at, at);
});

describe("cache pruner", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("keeps a file protected after a prune started, and prunes it once released", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-pruner-" });
        const roots = CachePruner.cacheDirectories(dataDir, path);
        const cache = path.join(dataDir, "cache");

        const finished = path.join(cache, "music", "fmp4-aac", "song-1.m4a");

        yield* fs.makeDirectory(path.dirname(finished), { recursive: true });

        const listing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const listings = yield* Ref.make(0);
        const held = yield* listingHeldUntil(cache, { reached: listing, release }, listings);

        const pruner = yield* CachePruner.make(roots, 64 * KIB).pipe(
          Effect.provideService(FileSystem.FileSystem, held),
        );

        const running = yield* Effect.forkChild(pruner.prune);

        yield* Deferred.await(listing);

        // A transcode finishes while the prune is listing: bigger than the bound, and protected
        // only now, after the prune started.
        yield* fs.writeFile(finished, new Uint8Array(100 * KIB));

        const kept = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* pruner.protect([finished]);
            yield* Deferred.succeed(release, undefined);

            const summary = yield* Fiber.join(running);

            assert.isTrue(yield* fs.exists(finished));

            return summary;
          }),
        );

        assert.deepStrictEqual(kept, { removedFiles: 0, removedBytes: 0, keptBytes: 100 * KIB });

        const released = yield* pruner.prune;

        assert.isFalse(yield* fs.exists(finished));
        assert.strictEqual(released.removedFiles, 1);
      }),
    );

    it.effect("keeps a file protected while the same prune is removing another", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-pruner-" });
        // Both are past the bound; a prune removes the newer first.
        const first = path.join(dataDir, "cache", "tmdb", "first.json");
        const second = path.join(dataDir, "cache", "music", "aac-128", "second.m4a");

        yield* cacheFile(second, 40, 300);
        yield* cacheFile(first, 40, 200);
        yield* cacheFile(path.join(dataDir, "cache", "tmdb", "newest.json"), 40, 0);

        const removing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const held = yield* removalHeldUntil(first, { reached: removing, release });

        const pruner = yield* CachePruner.make(
          CachePruner.cacheDirectories(dataDir, path),
          64 * KIB,
        ).pipe(Effect.provideService(FileSystem.FileSystem, held));

        const running = yield* Effect.forkChild(pruner.prune);

        yield* Deferred.await(removing);

        // The prune counted both past the bound before this protection.
        const summary = yield* Effect.scoped(
          pruner
            .protect([second])
            .pipe(
              Effect.andThen(Deferred.succeed(release, undefined)),
              Effect.andThen(Fiber.join(running)),
            ),
        );

        assert.isFalse(yield* fs.exists(first));
        assert.isTrue(yield* fs.exists(second));
        assert.deepStrictEqual(summary, {
          removedFiles: 1,
          removedBytes: 40 * KIB,
          keptBytes: 80 * KIB,
        });
      }),
    );

    it.effect("waits out a removal of the file it protects, so the file is protected or gone", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-pruner-" });
        const old = path.join(dataDir, "cache", "music", "aac-128", "old.m4a");

        yield* cacheFile(old, 100, 300);

        const removing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const held = yield* removalHeldUntil(old, { reached: removing, release });

        const pruner = yield* CachePruner.make(
          CachePruner.cacheDirectories(dataDir, path),
          64 * KIB,
        ).pipe(Effect.provideService(FileSystem.FileSystem, held));

        const running = yield* Effect.forkChild(pruner.prune);

        yield* Deferred.await(removing);

        const protecting = yield* Effect.forkChild(Effect.scoped(pruner.protect([old])), {
          startImmediately: true,
        });

        // Still waiting: the file is half way out.
        assert.isUndefined(protecting.pollUnsafe());

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(protecting);

        assert.isFalse(yield* fs.exists(old));
        assert.strictEqual((yield* Fiber.join(running)).removedFiles, 1);
      }),
    );

    it.effect("answers every call made during a prune with one more prune", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-pruner-" });
        const roots = CachePruner.cacheDirectories(dataDir, path);
        const cache = path.join(dataDir, "cache");

        yield* fs.makeDirectory(cache, { recursive: true });

        const listing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const listings = yield* Ref.make(0);
        const held = yield* listingHeldUntil(cache, { reached: listing, release }, listings);

        const pruner = yield* CachePruner.make(roots, 64 * KIB).pipe(
          Effect.provideService(FileSystem.FileSystem, held),
        );

        const first = yield* Effect.forkChild(pruner.prune);

        yield* Deferred.await(listing);

        const big = path.join(cache, "big.json");

        yield* fs.writeFile(big, new Uint8Array(100 * KIB));

        // Both ask while the first prune runs.
        const second = yield* Effect.forkChild(pruner.prune, { startImmediately: true });
        const third = yield* Effect.forkChild(pruner.prune, { startImmediately: true });

        yield* Deferred.succeed(release, undefined);

        assert.strictEqual((yield* Fiber.join(first)).removedFiles, 1);
        assert.strictEqual((yield* Fiber.join(second)).removedFiles, 0);
        assert.strictEqual((yield* Fiber.join(third)).removedFiles, 0);
        assert.strictEqual(yield* Ref.get(listings), 2);
        assert.isFalse(yield* fs.exists(big));
      }),
    );
  });
});
