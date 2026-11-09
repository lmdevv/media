import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path, Schedule, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";

const hasFfmpeg = await ffmpegAvailable();

const writeSleeper = (file: string) =>
  FileSystem.FileSystem.use((fs) =>
    fs
      .writeFileString(file, "#!/usr/bin/env node\nsetInterval(() => {}, 60_000);\n")
      .pipe(Effect.andThen(fs.chmod(file, 0o755)), Effect.as(file)),
  ).pipe(Effect.orDie);

const until = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  check.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("50 millis"), times: 100 }));

/** A process the server did not stop, in its own process group as the server starts ffmpeg. */
const leftOver = (command: string, output: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, ["-i", "input.mkv", "-f", "hls", output], { stdin: "ignore" }),
    );

    yield* until(
      fs.readFileString(`/proc/${String(handle.pid)}/cmdline`).pipe(Effect.orElseSucceed(() => "")),
      (cmdline) => cmdline.includes(command),
    );

    return handle;
  }).pipe(Effect.orDie);

describe.skipIf(!hasFfmpeg || process.platform !== "linux")("leftover encoders", () => {
  layer(NodeServices.layer, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "starting kills the encoders a previous run left writing into its transcode folder, and nothing else",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const folder = yield* fs.makeTempDirectoryScoped({ prefix: "movies-leftover-" });
          const transcodeDir = path.join(folder, "transcode");
          const ffmpegPath = yield* writeSleeper(path.join(folder, "ffmpeg.mjs"));
          const otherTool = yield* writeSleeper(path.join(folder, "other.mjs"));
          const output = path.join(transcodeDir, "stream", "1", "index.m3u8");
          const elsewhereOutput = path.join(folder, "elsewhere", "index.m3u8");
          const owned = yield* leftOver(ffmpegPath, output);
          const elsewhere = yield* leftOver(ffmpegPath, elsewhereOutput);
          const otherCommand = yield* leftOver(otherTool, output);
          const scope = yield* Scope.make();

          yield* Layer.buildWithScope(
            MediaTestServer.layer({ FFMPEG_PATH: ffmpegPath, TRANSCODE_DIR: transcodeDir }),
            scope,
          );

          assert.isFalse(
            yield* until(owned.isRunning, (running) => !running),
            "the leftover encoder is killed",
          );
          assert.isTrue(yield* elsewhere.isRunning, "an ffmpeg writing elsewhere keeps running");
          assert.isTrue(yield* otherCommand.isRunning, "another command keeps running");

          yield* Scope.close(scope, Exit.void);
        }),
      60_000,
    );
  });
});
