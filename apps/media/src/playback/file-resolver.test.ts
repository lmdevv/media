import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { MediaFileId } from "@media/contracts/ids";
import { MediaFileNotFound } from "@media/contracts/media-playback";
import { testConfigLayer } from "../testing/test-config.ts";
import { sidecarTrackId } from "../subtitles/subtitle-tracks.ts";
import * as FileResolver from "./file-resolver.ts";

const probe = {
  container: "mkv",
  formatName: "matroska,webm",
  durationSeconds: 1,
  startSeconds: 0,
  audio: [],
  subtitles: [],
  chapters: [],
} as const;

const sidecar = (path: string) =>
  ({ path, format: "srt", forced: false, hearingImpaired: false, default: false }) as const;

const testLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "movies-file-resolver-" });
    const library = path.join(base, "library");
    const outside = path.join(base, "outside");
    const inLibrary = (name: string) => path.join(library, name);
    const secret = path.join(outside, "secret.srt");
    const elsewhere = path.join(outside, "private.mkv");

    yield* fs.makeDirectory(library);
    yield* fs.makeDirectory(outside);
    yield* fs.writeFileString(inLibrary("Film (2000).mkv"), "");
    yield* fs.writeFileString(inLibrary("Film (2000).en.srt"), "1\n");
    yield* fs.writeFileString(secret, "1\n");
    yield* fs.writeFileString(elsewhere, "");
    yield* fs.symlink(inLibrary("Film (2000).en.srt"), inLibrary("Film (2000).es.srt"));
    yield* fs.symlink(secret, inLibrary("Film (2000).fr.srt"));
    yield* fs.symlink(elsewhere, inLibrary("Linked (2000).mkv"));

    const records = new Map([
      [
        "film",
        {
          path: inLibrary("Film (2000).mkv"),
          subtitles: [
            inLibrary("Film (2000).en.srt"),
            inLibrary("Film (2000).es.srt"),
            inLibrary("Film (2000).fr.srt"),
            inLibrary("Film (2000).de.srt"),
          ],
        },
      ],
      ["linked", { path: inLibrary("Linked (2000).mkv"), subtitles: [] }],
      ["outside", { path: elsewhere, subtitles: [] }],
    ]);

    const resolver = FileResolver.Service.of({
      resolve: (fileId) => {
        const record = records.get(fileId);

        return record === undefined
          ? Effect.fail(new MediaFileNotFound({ fileId }))
          : Effect.succeed({
              fileId,
              path: record.path,
              sizeBytes: 0,
              modifiedAtMs: 0,
              probe,
              subtitles: record.subtitles.map(sidecar),
            });
      },
    });

    return Layer.mergeAll(
      Layer.succeed(FileResolver.Service)(resolver),
      testConfigLayer({ LIBRARY_ROOTS: `${path.join(base, "unmounted")},${library}` }),
    );
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("resolveInsideRoots", () => {
  layer(testLayer)((it) => {
    it.effect("keeps a file and its sidecars inside the roots and drops sidecars that leave", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const resolved = yield* FileResolver.resolveInsideRoots(MediaFileId.make("film"), {
          sidecars: true,
        });

        assert.strictEqual(path.basename(resolved.path), "Film (2000).mkv");
        assert.strictEqual(resolved.path, yield* fs.realPath(resolved.path));
        assert.deepStrictEqual(
          resolved.subtitles.map((track) => path.basename(track.path)),
          ["Film (2000).en.srt", "Film (2000).es.srt"],
        );
      }),
    );

    it.effect("keeps each sidecar's name for its track and opens it by its real path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const resolved = yield* FileResolver.resolveInsideRoots(MediaFileId.make("film"), {
          sidecars: true,
        });

        assert.deepStrictEqual(
          new Set(resolved.subtitles.map((track) => sidecarTrackId(track.path))).size,
          2,
        );

        for (const track of resolved.subtitles) {
          assert.strictEqual(track.readPath, yield* fs.realPath(track.path));
        }
      }),
    );

    it.effect("leaves sidecars out unless they are asked for", () =>
      Effect.gen(function* () {
        const resolved = yield* FileResolver.resolveInsideRoots(MediaFileId.make("film"), {
          sidecars: false,
        });

        assert.deepStrictEqual(resolved.subtitles, []);
      }),
    );

    it.effect("refuses a file whose real path is outside the roots", () =>
      Effect.gen(function* () {
        for (const fileId of ["linked", "outside"]) {
          const refused = yield* FileResolver.resolveInsideRoots(MediaFileId.make(fileId), {
            sidecars: true,
          }).pipe(Effect.flip);

          assert.instanceOf(refused, MediaFileNotFound);
        }
      }),
    );
  });
});
