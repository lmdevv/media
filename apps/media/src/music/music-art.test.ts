import { createHash } from "node:crypto";
import { join } from "node:path";

import { Deferred, Effect, Fiber, HashSet, Option, Ref } from "effect";
import { describe, expect, it } from "vitest";

import type { ArtCatalog } from "./art-collector.ts";
import { artPath, saveArt } from "./art-store.ts";
import * as MusicArt from "./music-art.ts";
import * as Files from "./music-files.ts";
import { scanLibrary, type ScanProgress } from "./music-scan.ts";
import {
  MEDIA_TEST_TIMEOUT,
  memoryCatalog,
  PNG,
  runScoped,
  setFileTime,
  temporaryDirectory,
  writeBytes,
  writeSong,
} from "./testing/music-fixtures.ts";

describe("MusicArt", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("keeps a scan that reuses artwork out until a collection that found it unused ends", () =>
    runScoped(
      Effect.gen(function* () {
        const work = yield* temporaryDirectory("art-lane");
        const root = join(work, "music");
        const dataDir = join(work, "data");
        const song = join(root, "Album", "01 Song.flac");
        const hash = createHash("sha256").update(PNG).digest("hex");

        yield* Effect.promise(async () => {
          await writeSong(song, { seconds: 1 });
          await writeBytes(join(root, "Album", "cover.png"), PNG);
        });

        // The artwork an earlier scan stored and then released, written long before the grace.
        yield* saveArt(dataDir, PNG);
        yield* Effect.promise(() => setFileTime(artPath(dataDir, hash), Date.now() - 3_600_000));

        const memory = yield* memoryCatalog;
        const checked = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();

        // The collector's question answers what the catalog held when asked, after a delay, as a
        // round trip to the core does; the full collection at the start finds nothing in use.
        const catalog: ArtCatalog<never> = {
          inUse: (hashes) =>
            memory.tracks.pipe(
              Effect.map((tracks) => {
                const named = new Set(tracks.values().map(({ track }) => track.artHash));

                return hashes.filter((candidate) => named.has(candidate));
              }),
              Effect.tap(() => Deferred.succeed(checked, undefined)),
              Effect.tap(() => Deferred.await(answer)),
            ),
          hashes: () => Effect.succeed({ hashes: [], cursor: "", done: true }),
        };

        const art = yield* MusicArt.make(dataDir, catalog);

        yield* Ref.set(art.released, HashSet.make(hash));
        yield* art.collectReleased;
        yield* Deferred.await(checked);

        const progress = yield* Ref.make<ScanProgress>({ done: 0, total: null, message: "" });

        const scan = yield* art
          .scanning(
            scanLibrary(
              { libraryId: "library", folders: [root], dataDir, mode: "incremental" },
              memory.catalog,
              progress,
              art.released,
            ),
          )
          .pipe(Effect.forkScoped);

        // Without the lane, the scan would reuse the stored file and store the song meanwhile.
        expect(Option.isNone(yield* Fiber.await(scan).pipe(Effect.timeoutOption("1 second")))).toBe(
          true,
        );

        yield* Deferred.succeed(answer, undefined);
        expect((yield* Fiber.join(scan)).updated).toBe(1);

        const stored = (yield* memory.tracks).get(song)?.track.artHash;

        expect(stored).toBe(hash);
        expect((yield* Files.statPath(artPath(dataDir, hash))).size).toBe(PNG.length);
      }),
    ));
});
