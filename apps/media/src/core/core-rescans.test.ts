import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { LibraryId } from "@media/contracts/ids";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { testConfigLayer } from "../testing/test-config.ts";
import { foldersToWatch, pathsToSend } from "./core-rescans.ts";

describe("CoreRescans.pathsToSend", () => {
  it("sends each changed path once, none inside another it sends", () => {
    assert.deepStrictEqual(
      pathsToSend("/media", [
        "/media/movies/Film (2020)/film.mkv",
        "/media/movies/Film (2020)",
        "/media/movies/Film (2020)/film.nfo",
        "/media/shows/Show/s01e01.mkv",
        "/media/shows/Show/s01e01.mkv",
      ]),
      ["/media/movies/Film (2020)", "/media/shows/Show/s01e01.mkv"],
    );
  });

  it("keeps a sibling whose name only starts like another path", () => {
    assert.deepStrictEqual(pathsToSend("/media", ["/media/movies", "/media/movies 2/a.mkv"]), [
      "/media/movies",
      "/media/movies 2/a.mkv",
    ]);
  });

  it("sends the root when a burst named nothing or too many paths", () => {
    assert.deepStrictEqual(pathsToSend("/media", []), ["/media"]);

    const many = Array.from({ length: 33 }, (_, index) => `/media/movies/${String(index)}.mkv`);

    assert.deepStrictEqual(pathsToSend("/media", many), ["/media"]);
    assert.lengthOf(pathsToSend("/media", many.slice(0, 32)), 32);
  });
});

/** The folders a test lays out: an approved root, and paths in and around it. */
class Folders extends Context.Service<
  Folders,
  {
    readonly inside: string;
    readonly linked: string;
    readonly outside: string;
    readonly escaping: string;
    readonly unmounted: string;
  }
>()("test/CoreRescans/Folders") {}

const foldersLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "rescans-folders-" });
    const approved = path.join(base, "media");
    const inside = path.join(approved, "films");
    const outside = path.join(base, "outside");
    const linked = path.join(base, "films");
    const escaping = path.join(approved, "escape");

    yield* fs.makeDirectory(inside, { recursive: true });
    yield* fs.makeDirectory(outside);
    yield* fs.symlink(inside, linked);
    yield* fs.symlink(outside, escaping);

    const unmounted = path.join(base, "nas", "films");

    return Layer.succeed(
      Folders,
      Folders.of({ inside, linked, outside, escaping, unmounted }),
    ).pipe(Layer.merge(testConfigLayer({ LIBRARY_ROOTS: approved, DATA_DIR: base })));
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("CoreRescans.foldersToWatch", () => {
  const libraryId = LibraryId.make("library-1");

  layer(foldersLayer, { excludeTestServices: true })((test) => {
    test.effect(
      "watches a folder linked into an approved root at its own path, and none that leads outside",
      () =>
        Effect.gen(function* () {
          const { inside, linked, outside, escaping, unmounted } = yield* Folders;

          const watched = yield* foldersToWatch([
            { libraryId, folders: [inside, linked, outside, escaping, unmounted] },
          ]);

          assert.deepStrictEqual(watched, [
            { libraryId, roots: [inside] },
            { libraryId, roots: [linked] },
            { libraryId, roots: [unmounted] },
          ]);
        }),
    );
  });
});
