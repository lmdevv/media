import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { NotFound } from "@media/contracts/errors";

import { testConfigLayer } from "../testing/test-config.ts";
import * as ServerFolders from "./server-folders.ts";

class Tree extends Context.Service<
  Tree,
  { readonly root: string; readonly missing: string; readonly outside: string }
>()("test/ServerFolders/Tree") {}

const testLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "movies-server-folders-" });
    const root = path.join(base, "media");
    const missing = path.join(base, "nas");
    const outside = path.join(base, "private");

    yield* fs.makeDirectory(path.join(root, "Movies", "Extras"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, "shows"));
    yield* fs.makeDirectory(path.join(root, ".cache"));
    yield* fs.makeDirectory(outside);
    yield* fs.writeFileString(path.join(root, "notes.txt"), "");
    yield* fs.symlink(outside, path.join(root, "linked"));
    yield* fs.symlink(path.join(root, "Movies"), path.join(root, "alias"));
    yield* fs.symlink(root, path.join(base, "door"));

    yield* Effect.forEach(
      Array.from({ length: 1001 }, (_, index) => path.join(root, "many", `folder ${index}`)),
      (folder) => fs.makeDirectory(folder, { recursive: true }),
      { concurrency: 32 },
    );

    yield* Effect.forEach(
      Array.from({ length: 1000 }, (_, index) => path.join(root, "thousand", `folder ${index}`)),
      (folder) => fs.makeDirectory(folder, { recursive: true }),
      { concurrency: 32 },
    );
    yield* fs.writeFileString(path.join(root, "thousand", "zz notes.txt"), "");

    return Layer.merge(
      Layer.succeed(Tree, { root, missing, outside }),
      testConfigLayer({ LIBRARY_ROOTS: `${root}/,${missing}` }),
    );
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

layer(testLayer)("ServerFolders.list", (it) => {
  it.effect("lists the approved roots that exist when no folder is given", () =>
    Effect.gen(function* () {
      const { root } = yield* Tree;
      const listed = yield* ServerFolders.list(undefined);

      assert.deepStrictEqual(listed, {
        path: null,
        parent: null,
        folders: [{ name: root, path: root }],
        truncated: false,
      });
    }),
  );

  it.effect(
    "lists a root's folders by name, leaving out hidden folders, files, and links out",
    () =>
      Effect.gen(function* () {
        const { root } = yield* Tree;
        const listed = yield* ServerFolders.list(root);

        assert.strictEqual(listed.path, root);
        assert.isNull(listed.parent);
        assert.deepStrictEqual(
          listed.folders.map((folder) => folder.name),
          ["alias", "many", "Movies", "shows", "thousand"],
        );
        assert.strictEqual(listed.folders[2]?.path, `${root}/Movies`);
        assert.isFalse(listed.truncated);
      }),
  );

  it.effect("lists the first thousand folders by name and says more were left out", () =>
    Effect.gen(function* () {
      const { root } = yield* Tree;
      const listed = yield* ServerFolders.list(`${root}/many`);

      assert.lengthOf(listed.folders, 1000);
      assert.strictEqual(listed.folders[0]?.name, "folder 0");
      assert.strictEqual(listed.folders[999]?.name, "folder 999");
      assert.isTrue(listed.truncated);
    }),
  );

  it.effect("says nothing was left out when exactly a thousand folders are inside", () =>
    Effect.gen(function* () {
      const { root } = yield* Tree;
      const listed = yield* ServerFolders.list(`${root}/thousand`);

      assert.lengthOf(listed.folders, 1000);
      assert.isFalse(listed.truncated);
    }),
  );

  it.effect("points a folder inside a root at its parent", () =>
    Effect.gen(function* () {
      const { root } = yield* Tree;
      const listed = yield* ServerFolders.list(`${root}/Movies/`);

      assert.strictEqual(listed.path, `${root}/Movies`);
      assert.strictEqual(listed.parent, root);
      assert.deepStrictEqual(listed.folders, [{ name: "Extras", path: `${root}/Movies/Extras` }]);
    }),
  );

  it.effect("refuses folders outside the roots, behind links, missing, or climbing out", () =>
    Effect.gen(function* () {
      const { root, missing, outside } = yield* Tree;
      const base = root.slice(0, root.lastIndexOf("/"));

      for (const folder of [
        outside,
        `${root}/linked`,
        missing,
        `${root}/gone`,
        `${root}/..`,
        `${root}/Movies/../Movies`,
        `${base}/door`,
        `${base}/door/Movies`,
      ]) {
        const failure = yield* Effect.flip(ServerFolders.list(folder));

        assert.instanceOf(failure, NotFound, folder);
        assert.include(failure.message, "isn’t available to the server");
      }
    }),
  );
});
