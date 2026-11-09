import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Path, Schedule, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import * as MediaTools from "./media-tools.ts";

const hasFfmpeg = await ffmpegAvailable();

// Node runs the script directly, so the process keeps one executable from its first instruction.
const writeSleeper = (file: string) =>
  FileSystem.FileSystem.use((fs) =>
    fs
      .writeFileString(file, `#!${process.execPath}\nsetInterval(() => {}, 60_000);\n`)
      .pipe(Effect.andThen(fs.chmod(file, 0o755)), Effect.as(file)),
  ).pipe(Effect.orDie);

const until = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  check.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("50 millis"), times: 100 }));

/** A process in its own process group, as the server starts ffmpeg, that the server did not start. */
const unrelated = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore" }));

    yield* until(
      fs.readFileString(`/proc/${String(handle.pid)}/cmdline`).pipe(Effect.orElseSucceed(() => "")),
      (cmdline) => cmdline.includes(command),
    );

    return handle;
  }).pipe(Effect.orDie);

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "movies-encoders-" });
  const transcodeDir = path.join(folder, "transcode");
  const dataDir = path.join(folder, "data");
  const ffmpegPath = yield* writeSleeper(path.join(folder, "ffmpeg.mjs"));

  const server = (scope: Scope.Scope) =>
    Layer.buildWithScope(
      MediaTestServer.layer({
        FFMPEG_PATH: ffmpegPath,
        TRANSCODE_DIR: transcodeDir,
        DATA_DIR: dataDir,
      }),
      scope,
    );

  return { transcodeDir, dataDir, ffmpegPath, server };
});

describe.skipIf(!hasFfmpeg || process.platform !== "linux")("encoder records", () => {
  layer(NodeServices.layer, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "starting leaves running an ffmpeg the server did not start, even one reading from its transcode folder",
      () =>
        Effect.gen(function* () {
          const { transcodeDir, ffmpegPath, server } = yield* workspace;

          const reader = yield* unrelated(ffmpegPath, [
            "-i",
            `${transcodeDir}/input.wav`,
            "-f",
            "null",
            "-",
          ]);

          const scope = yield* Scope.make();

          yield* server(scope);

          assert.isTrue(yield* reader.isRunning, "the unrelated ffmpeg keeps running");
          yield* Scope.close(scope, Exit.void);
        }),
      60_000,
    );

    it.effect(
      "starting kills the encoders an earlier run started and never saw exit, and no process that took a recorded id",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { transcodeDir, dataDir, ffmpegPath, server } = yield* workspace;
          const crashed = yield* Scope.make();
          const tools = Context.get(yield* server(crashed), MediaTools.Service);
          const output = `${transcodeDir}/stream/1/index.m3u8`;
          const encoder = yield* Scope.make();

          const running = yield* tools
            .startFfmpeg(["-f", "hls", output])
            .pipe(Scope.provide(encoder), Effect.orDie);

          const exited = yield* running.exit.pipe(Effect.exit, Effect.forkChild);
          const reused = yield* unrelated(ffmpegPath, ["-f", "hls", output]);

          const executable = yield* fs
            .readLink(`/proc/${String(reused.pid)}/exe`)
            .pipe(Effect.orDie);

          yield* fs
            .makeDirectory(path.join(dataDir, "encoders"), { recursive: true })
            .pipe(Effect.orDie);
          yield* fs
            .writeFileString(
              path.join(dataDir, "encoders", `${String(reused.pid)}.json`),
              JSON.stringify({ group: reused.pid, startTime: "1", executable }),
            )
            .pipe(Effect.orDie);

          assert.isTrue(exited.pollUnsafe() === undefined, "the earlier run's encoder runs");

          const restarted = yield* Scope.make();

          yield* server(restarted);

          const exit = yield* until(
            Effect.sync(() => exited.pollUnsafe()),
            (polled) => polled !== undefined,
          );

          assert.isDefined(exit, "the earlier run's encoder is killed");
          assert.isTrue(yield* reused.isRunning, "a process that took a recorded id keeps running");

          yield* Scope.close(restarted, Exit.void);
          yield* Scope.close(encoder, Exit.void);
          yield* Scope.close(crashed, Exit.void);
        }),
      60_000,
    );
  });
});
