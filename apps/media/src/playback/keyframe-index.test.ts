import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import * as DiskCache from "../disk-cache.ts";
import { MediaFileId } from "@media/contracts/ids";
import { probeFile } from "../media/media-probe.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as KeyframeIndex from "./keyframe-index.ts";

const hasFfmpeg = await ffmpegAvailable();

const indexLayer = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* FixtureWorkspace.Service;
    const path = yield* Path.Path;
    const config = testConfigLayer({ DATA_DIR: path.join(workspace.root, "data") });

    return KeyframeIndex.layer.pipe(
      Layer.provideMerge(DiskCache.layer),
      Layer.provideMerge(MediaTools.layer),
      Layer.provide(config),
    );
  }),
).pipe(Layer.provideMerge(FixtureWorkspace.layer), Layer.provideMerge(NodeServices.layer));

const resolved = Effect.fn(function* (file: string, fileId: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);
  const probe = yield* probeFile(file);

  return {
    fileId: MediaFileId.make(fileId),
    path: file,
    sizeBytes: Number(info.size),
    modifiedAtMs: 1,
    probe,
    subtitles: [],
  };
});

describe.skipIf(!hasFfmpeg)("KeyframeIndex", () => {
  layer(indexLayer, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect("reads Matroska Cues, scans other containers, and caches both", () =>
      Effect.gen(function* () {
        const { library } = yield* FixtureWorkspace.Service;
        const path = yield* Path.Path;
        const index = yield* KeyframeIndex.Service;
        const tools = yield* MediaTools.Service;
        const mkv = yield* resolved(path.join(library.moviesRoot, library.remuxMovie), "remux");
        const mp4 = yield* resolved(path.join(library.moviesRoot, library.directMovie), "direct");

        const fromCues = yield* index.keyframes(mkv);
        const fromScan = yield* index.keyframes(mp4);

        const ffprobeKeyframes = (yield* tools.ffprobe([
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "packet=pts_time,flags",
          "-of",
          "csv=p=0",
          mkv.path,
        ]))
          .split("\n")
          .filter((line) => line.includes(",K"))
          .map((line) => Number(line.split(",")[0]));

        assert.deepStrictEqual(fromCues, [0, 2, 4, 6, 8, 10]);
        assert.deepStrictEqual(fromCues, ffprobeKeyframes);
        assert.deepStrictEqual(fromScan.slice(0, 3), [0, 2, 4]);

        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(mp4.path);

        assert.deepStrictEqual(yield* index.keyframes(mp4), fromScan);
      }),
    );
  });
});
