import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { isNetworkFileSystem, snapshot } from "./library-poller.ts";

describe("library poller", () => {
  layer(NodeServices.layer)((withFs) => {
    withFs.effect("notices added, removed, and renamed entries anywhere below the root", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-poll-" });
        const deep = path.join(root, "Show", "Season 01");

        yield* fs.makeDirectory(deep, { recursive: true });
        const first = yield* snapshot(root, new Map());

        assert.isTrue(first.changed);
        assert.strictEqual(first.snapshot.size, 3);

        const quiet = yield* snapshot(root, first.snapshot);

        assert.isFalse(quiet.changed);

        // Folder times have millisecond resolution or coarser; make the change unmistakable.
        const touch = (folder: string) =>
          fs.utimes(folder, new Date(), new Date(Date.now() + 5000));

        yield* fs.writeFileString(path.join(deep, "Show S01E01.mkv"), "");
        yield* touch(deep);
        const added = yield* snapshot(root, quiet.snapshot);

        assert.isTrue(added.changed);
        assert.isFalse((yield* snapshot(root, added.snapshot)).changed);

        yield* fs.remove(path.join(root, "Show"), { recursive: true });
        yield* touch(root);
        const removed = yield* snapshot(root, added.snapshot);

        assert.isTrue(removed.changed);
        assert.strictEqual(removed.snapshot.size, 1);
      }),
    );
  });

  describe("file system types", () => {
    it.effect("polls network and user-space mounts, and watches local disks", () =>
      Effect.sync(() => {
        assert.isTrue(isNetworkFileSystem(0x6969));
        assert.isTrue(isNetworkFileSystem(0xff534d42));
        assert.isTrue(isNetworkFileSystem(0x01021997));
        assert.isTrue(isNetworkFileSystem(0x65735546));
        // ext4, btrfs, xfs, zfs, tmpfs
        assert.isFalse(isNetworkFileSystem(0xef53));
        assert.isFalse(isNetworkFileSystem(0x9123683e));
        assert.isFalse(isNetworkFileSystem(0x58465342));
        assert.isFalse(isNetworkFileSystem(0x2fc12fc1));
        assert.isFalse(isNetworkFileSystem(0x01021994));
      }),
    );
  });
});
