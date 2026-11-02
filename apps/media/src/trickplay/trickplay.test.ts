import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { MediaFileId } from "@movies/contracts/ids";
import { TrickplayManifest, trickplayVersion } from "@movies/contracts/trickplay";
import {
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
} from "effect";

import { probeFile } from "../media/media-probe.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { ResolvedMediaFile } from "../playback/file-resolver.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { generate } from "./trickplay-generator.ts";
import * as TrickplayJob from "./trickplay-job.ts";
import * as TrickplayStore from "./trickplay-store.ts";

const hasFfmpeg = await ffmpegAvailable();

const INTERVAL = Duration.seconds(10);

const testLayer = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* FixtureWorkspace.Service;
    const path = yield* Path.Path;
    const config = testConfigLayer({ DATA_DIR: path.join(workspace.root, "data") });

    return Layer.mergeAll(TrickplayStore.layer, MediaTools.layer).pipe(Layer.provide(config));
  }),
).pipe(Layer.provideMerge(FixtureWorkspace.layer), Layer.provideMerge(NodeServices.layer));

const encode = Effect.fn(function* (name: string, args: ReadonlyArray<string>) {
  const { root } = yield* FixtureWorkspace.Service;
  const path = yield* Path.Path;
  const tools = yield* MediaTools.Service;
  const output = path.join(root, name);

  yield* tools.ffmpeg(["-hide_banner", "-nostdin", "-v", "error", "-y", ...args, output]);

  return output;
});

const resolved = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);

  return {
    fileId: MediaFileId.make("file1"),
    path: file,
    sizeBytes: Number(info.size),
    modifiedAtMs: 1_760_000_000_000,
    probe: yield* probeFile(file),
    subtitles: [],
  } satisfies ResolvedMediaFile;
});

const built = (sheets: number) => (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* Effect.forEach(
      Array.from({ length: sheets }, (_, index) => index),
      (index) =>
        fs.writeFileString(path.join(folder, `${String(index)}.jpg`), "jpeg").pipe(Effect.orDie),
    );

    return yield* Schema.decodeEffect(TrickplayManifest)({
      version: "a-1",
      intervalMs: 10_000,
      tileWidth: 320,
      tileHeight: 180,
      columns: 10,
      rows: 10,
      thumbnailCount: sheets * 100,
      sheetCount: sheets,
    }).pipe(Effect.orDie);
  });

/** Full-range luma of the ramp clip's frame at `seconds` (4 per second, limited range). */
const rampLuma = (seconds: number): number =>
  (Math.max(0, Math.min(235, 4 * seconds) - 16) * 255) / 219;

const sizeOf = Effect.fn(function* (image: string) {
  const tools = yield* MediaTools.Service;

  const json = yield* tools.ffprobe([
    "-v",
    "error",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    image,
  ]);

  return json.trim();
});

describe.skipIf(!hasFfmpeg)("trickplay", () => {
  layer(testLayer, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "tiles a thumbnail every interval, sized by the display aspect ratio",
      () =>
        Effect.gen(function* () {
          const store = yield* TrickplayStore.Service;
          const fs = yield* FileSystem.FileSystem;

          const clip = yield* encode("anamorphic.mkv", [
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=360x270:rate=24:duration=35",
            "-vf",
            "setsar=4/3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "24",
          ]);

          const file = yield* resolved(clip);
          const version = trickplayVersion(file.sizeBytes, file.modifiedAtMs);

          const manifest = yield* store.publish("file1", version, (folder) =>
            generate(file, version, INTERVAL, folder),
          );

          assert.deepStrictEqual(manifest, {
            version,
            intervalMs: 10_000,
            tileWidth: 320,
            tileHeight: 180,
            columns: 10,
            rows: 10,
            thumbnailCount: 4,
            sheetCount: 1,
          });

          const sheet = yield* store.find("file1", version, "0.jpg");
          const stored = yield* store.find("file1", version, "manifest.json");

          assert.isTrue(Option.isSome(sheet) && Option.isSome(stored));
          assert.strictEqual(yield* sizeOf(Option.getOrThrow(sheet)), "3200,1800");
          assert.deepStrictEqual(
            yield* Schema.decodeEffect(Schema.fromJsonString(TrickplayManifest))(
              yield* fs.readFileString(Option.getOrThrow(stored)),
            ),
            manifest,
          );
        }),
      60_000,
    );

    it.effect(
      "shows the last keyframe at or before each thumbnail's time",
      () =>
        Effect.gen(function* () {
          const store = yield* TrickplayStore.Service;
          const tools = yield* MediaTools.Service;

          const clip = yield* encode("ramp.mkv", [
            "-f",
            "lavfi",
            "-i",
            "nullsrc=size=320x180:rate=24:duration=40,geq=lum='4*T':cb=128:cr=128",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "72",
            "-keyint_min",
            "72",
            "-sc_threshold",
            "0",
          ]);

          const file = yield* resolved(clip);
          const version = trickplayVersion(file.sizeBytes, 1);

          yield* store.publish("ramp", version, (folder) =>
            generate(file, version, INTERVAL, folder),
          );

          const sheet = Option.getOrThrow(yield* store.find("ramp", version, "0.jpg"));

          const measured = yield* Effect.forEach([0, 1, 2, 3], (tile) =>
            tools
              .ffprobe([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                `movie=${sheet},crop=320:180:${String(tile * 320)}:0,signalstats`,
                "-show_entries",
                "frame_tags=lavfi.signalstats.YAVG",
                "-of",
                "csv=p=0",
              ])
              .pipe(Effect.map((text) => Number(text.trim()))),
          );

          measured.forEach((value, tile) => {
            const seconds = [0, 9, 18, 30][tile] ?? 0;

            assert.approximately(value, rampLuma(seconds), 6, `tile ${String(tile)}`);
          });
        }),
      60_000,
    );

    it.effect(
      "tone-maps HDR video or falls back to the frames as they decode",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const file = yield* resolved(path.join(library.moviesRoot, library.hdrMovie));
          const folder = yield* fs.makeTempDirectoryScoped();

          assert.strictEqual(file.probe.video?.dynamicRange, "hdr10");

          const manifest = yield* generate(file, "1-1", INTERVAL, folder);

          assert.strictEqual(manifest.thumbnailCount, 1);
          assert.strictEqual(manifest.tileWidth, 320);
          assert.deepStrictEqual(yield* fs.readDirectory(folder), ["0.jpg"]);
        }).pipe(Effect.scoped),
      60_000,
    );

    it.effect(
      "counts only the frames there are when the audio outlasts the video",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;

          const clip = yield* encode("long-audio.mkv", [
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=60",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "24",
            "-c:a",
            "aac",
          ]);

          const file = yield* resolved(clip);
          const folder = yield* fs.makeTempDirectoryScoped();
          const manifest = yield* generate(file, "1-1", INTERVAL, folder);

          assert.isAbove(file.probe.durationSeconds, 59);
          assert.strictEqual(manifest.thumbnailCount, 3);
          assert.deepStrictEqual(yield* fs.readDirectory(folder), ["0.jpg"]);
        }).pipe(Effect.scoped),
      60_000,
    );

    it.effect("refuses files without video", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const clip = yield* encode("audio.m4a", [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=3",
          "-c:a",
          "aac",
        ]);

        const folder = yield* fs.makeTempDirectoryScoped();
        const exit = yield* Effect.exit(generate(yield* resolved(clip), "1-1", INTERVAL, folder));

        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "no video");
      }).pipe(Effect.scoped),
    );

    it.effect(
      "discards thumbnails of a file that changed while they were made",
      () =>
        Effect.gen(function* () {
          const store = yield* TrickplayStore.Service;
          const fs = yield* FileSystem.FileSystem;

          const clip = yield* encode("changing.mkv", [
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=12",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
          ]);

          const file = yield* resolved(clip);
          const info = yield* fs.stat(clip);
          const mtime = Option.getOrThrow(info.mtime);
          const version = trickplayVersion(Number(info.size), mtime.getTime());

          yield* store.publish("changing", version, TrickplayJob.build(file, version, INTERVAL));
          assert.isTrue(Option.isSome(yield* store.find("changing", version, "manifest.json")));

          const later = new Date(mtime.getTime() + 60_000);

          yield* fs.utimes(clip, later, later);

          const exit = yield* Effect.exit(
            store.publish("changed", version, TrickplayJob.build(file, version, INTERVAL)),
          );

          assert.isTrue(Exit.isFailure(exit));
          assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "changed while");
          assert.isTrue(Option.isNone(yield* store.find("changed", version, "manifest.json")));
        }),
      60_000,
    );

    it.effect(
      "keeps other versions for the sweep, keeps them after a failed build, and stays inside its folder",
      () =>
        Effect.gen(function* () {
          const store = yield* TrickplayStore.Service;

          yield* store.publish("file2", "a-1", built(1));
          yield* store.publish("file2", "b-2", built(2));

          assert.isTrue(Option.isSome(yield* store.find("file2", "a-1", "0.jpg")));
          assert.isTrue(Option.isSome(yield* store.find("file2", "b-2", "1.jpg")));

          const failed = yield* Effect.exit(
            store.publish("file2", "c-3", () => Effect.fail("broken")),
          );

          assert.isTrue(Exit.isFailure(failed));
          assert.isTrue(Option.isSome(yield* store.find("file2", "b-2", "0.jpg")));
          assert.isTrue(Option.isNone(yield* store.find("file2", "c-3", "manifest.json")));

          for (const [fileId, version, name] of [
            ["file2", "b-2", "../../file1/x.jpg"],
            ["..", "b-2", "0.jpg"],
            ["file2", "..", "0.jpg"],
            ["file2", "b-2", "0.png"],
            ["file2", "b-2", ".building-x"],
          ] as const) {
            assert.isTrue(
              Option.isNone(yield* store.find(fileId, version, name)),
              `${fileId}/${version}/${name}`,
            );
          }
        }),
    );

    it.effect("keeps a version's earlier set when its replacement cannot take its place", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* FixtureWorkspace.Service;
        const store = yield* TrickplayStore.Service;

        yield* store.publish("file3", "a-1", built(2));

        const intoPlaceFails = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          rename: (from: string, to: string) =>
            path.basename(from).startsWith(".building-a-1-")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: from,
                  }),
                )
              : fs.rename(from, to),
        });

        // Fresh: the layer is memoized, and the store already built uses the working disk.
        const failing = Context.get(
          yield* Layer.build(
            Layer.fresh(TrickplayStore.layer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  intoPlaceFails,
                  testConfigLayer({ DATA_DIR: path.join(root, "data") }),
                ),
              ),
            ),
          ),
          TrickplayStore.Service,
        );

        const exit = yield* Effect.exit(failing.publish("file3", "a-1", built(1)));

        assert.isTrue(Exit.isFailure(exit));
        assert.isTrue(Option.isSome(yield* store.find("file3", "a-1", "manifest.json")));
        assert.isTrue(Option.isSome(yield* store.find("file3", "a-1", "1.jpg")));
      }).pipe(Effect.scoped),
    );

    it.effect("sweeps thumbnails the catalog no longer uses, sparing recent ones", () =>
      Effect.gen(function* () {
        const store = yield* TrickplayStore.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* FixtureWorkspace.Service;
        const base = path.join(root, "data", "trickplay");

        const stub = (fileId: string, version: string, ageHours: number) =>
          Effect.gen(function* () {
            const folder = path.join(base, fileId, version);
            const then = new Date(Date.now() - ageHours * 3_600_000);

            yield* fs.makeDirectory(folder, { recursive: true });
            yield* fs.writeFileString(path.join(folder, "0.jpg"), "jpeg");
            yield* fs.utimes(folder, then, then);
          });

        yield* stub("kept", "k-1", 5);
        yield* stub("kept", "k-0", 5);
        yield* stub("gone", "g-1", 5);
        yield* stub("fresh", "f-1", 0);
        yield* stub("unknown", "u-1", 5);

        const asked: Array<string> = [];

        const removed = yield* store.sweep((fileIds) => {
          asked.push(...fileIds);

          return Effect.succeed(
            new Map([
              ["kept", "k-1"],
              ["gone", null],
              ["fresh", null],
            ]),
          );
        });

        const left = (fileId: string) =>
          fs.readDirectory(path.join(base, fileId)).pipe(Effect.orElseSucceed(() => []));

        assert.strictEqual(removed, 3);
        assert.deepStrictEqual(asked.toSorted(), [
          "changed",
          "changing",
          "file1",
          "file2",
          "file3",
          "fresh",
          "gone",
          "kept",
          "ramp",
          "unknown",
        ]);
        assert.deepStrictEqual(yield* left("kept"), ["k-1"]);
        assert.deepStrictEqual(yield* left("gone"), []);
        assert.deepStrictEqual(yield* left("unknown"), []);
        assert.deepStrictEqual(yield* left("fresh"), ["f-1"]);
      }),
    );
  });
});
