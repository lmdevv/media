import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Clock, Effect, Exit, FileSystem, Layer, Path, Schedule, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";

const hasFfmpeg = await ffmpegAvailable();

const SERVER_DEATH_MS = 1000;

// The stand-in writes its pid to its last argument, then waits like an encoder.
const sleeperScript = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.argv.at(-1), String(process.pid));
setInterval(() => {}, 60_000);
`;

// A server in miniature: the real MediaTools layer starting one encoder, until it is killed.
const harnessScript = `import { createRequire } from "node:module";
const [packageJson, mediaTools, testConfig, ffmpegPath, pidFile] = process.argv.slice(2);
const require = createRequire(packageJson);
const { Effect, Layer } = await import(require.resolve("effect"));
const { NodeServices } = await import(require.resolve("@effect/platform-node"));
const MediaTools = await import(mediaTools);
const { testConfigLayer } = await import(testConfig);
const tools = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({ FFMPEG_PATH: ffmpegPath })),
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(
  MediaTools.Service.use((service) => service.startFfmpeg(["-f", "hls", pidFile])).pipe(
    Effect.andThen(Effect.never),
    Effect.scoped,
    Effect.provide(tools),
  ),
);
`;

const alive = (pid: number) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(`/proc/${String(pid)}/stat`)).pipe(
    Effect.map((stat) => stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"),
    Effect.orElseSucceed(() => false),
  );

// Holds the launcher until the server that spawned it is gone, then runs the real setpriv, as a
// server that dies before its tool's death signal is set leaves it. That is the only way the
// launcher can reach the parent check with the server gone: had the server died after the signal
// was set, the kernel would have killed the launcher first.
const heldSetprivScript = (realSetpriv: string) => `#!/bin/sh
parent=$PPID
echo $$ > "$(dirname "$0")/launcher.pid.tmp"
mv "$(dirname "$0")/launcher.pid.tmp" "$(dirname "$0")/launcher.pid"
while [ "$(cut -d" " -f4 /proc/$$/stat)" = "$parent" ]; do sleep 0.05; done
exec ${JSON.stringify(realSetpriv)} "$@"
`;

const onPath = (command: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const directory of (process.env["PATH"] ?? "").split(":")) {
      const candidate = path.join(directory, command);

      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    }

    return yield* Effect.die(`no ${command} on PATH`);
  });

/** Starts the miniature server, whose encoder writes its pid to `pidFile`. */
const startServer = (
  folder: string,
  pidFile: string,
  searchPath: string = process.env["PATH"] ?? "",
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sleeper = yield* writeExecutable(path.join(folder, "ffmpeg.mjs"), sleeperScript);
    const harness = yield* writeExecutable(path.join(folder, "server.mjs"), harnessScript);

    return yield* spawner
      .spawn(
        ChildProcess.make(
          process.execPath,
          [
            harness,
            path.join(import.meta.dirname, "..", "..", "package.json"),
            path.join(import.meta.dirname, "media-tools.ts"),
            path.join(import.meta.dirname, "..", "testing", "test-config.ts"),
            sleeper,
            pidFile,
          ],
          { stdin: "ignore", env: { PATH: searchPath }, extendEnv: true },
        ),
      )
      .pipe(Effect.orDie);
  });

const writeExecutable = (file: string, content: string) =>
  FileSystem.FileSystem.use((fs) =>
    fs.writeFileString(file, content).pipe(Effect.andThen(fs.chmod(file, 0o755)), Effect.as(file)),
  ).pipe(Effect.orDie);

describe.skipIf(!hasFfmpeg || process.platform !== "linux")("tool lifetime", () => {
  layer(NodeServices.layer, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "the tools a server started die within a second of the server being killed",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const folder = yield* fs.makeTempDirectoryScoped({ prefix: "movies-tool-lifetime-" });
          const pidFile = path.join(folder, "ffmpeg.pid");
          const server = yield* startServer(folder, pidFile);

          const pid = yield* fs
            .readFileString(pidFile)
            .pipe(
              Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
              Effect.map(Number),
              Effect.orDie,
            );

          assert.isTrue(yield* alive(pid), "the server's ffmpeg runs");

          yield* Effect.sync(() => process.kill(server.pid, "SIGKILL"));

          const killed = yield* Clock.currentTimeMillis;

          const left = yield* alive(pid).pipe(
            Effect.repeat({
              until: (running) => !running,
              schedule: Schedule.spaced("20 millis"),
              times: 100,
            }),
          );

          const elapsed = (yield* Clock.currentTimeMillis) - killed;

          if (left) yield* Effect.sync(() => process.kill(-pid, "SIGKILL"));

          assert.isFalse(left, "the ffmpeg of a killed server exits");
          assert.isBelow(elapsed, SERVER_DEATH_MS, `the ffmpeg exited ${String(elapsed)} ms after`);
        }),
      60_000,
    );

    it.effect(
      "a server that dies before its tool's death signal is set starts no tool",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const folder = yield* fs.makeTempDirectoryScoped({ prefix: "movies-tool-lifetime-" });
          const pidFile = path.join(folder, "ffmpeg.pid");
          const bin = path.join(folder, "bin");

          yield* fs.makeDirectory(bin).pipe(Effect.orDie);
          yield* writeExecutable(
            path.join(bin, "setpriv"),
            heldSetprivScript(yield* onPath("setpriv")),
          );

          const server = yield* startServer(folder, pidFile, `${bin}:${process.env["PATH"] ?? ""}`);

          const launcher = yield* fs.readFileString(path.join(bin, "launcher.pid")).pipe(
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
            Effect.map((text) => Number(text.trim())),
            Effect.orDie,
          );

          yield* Effect.sync(() => process.kill(server.pid, "SIGKILL"));

          const left = yield* alive(launcher).pipe(
            Effect.repeat({
              until: (running) => !running,
              schedule: Schedule.spaced("50 millis"),
              times: 100,
            }),
          );

          if (left) yield* Effect.sync(() => process.kill(-launcher, "SIGKILL"));

          assert.isFalse(left, "the launcher of a dead server exits instead of starting its tool");
          assert.isFalse(yield* fs.exists(pidFile).pipe(Effect.orDie), "the tool never started");
        }),
      60_000,
    );

    it.effect(
      "starting never touches an ffmpeg the server did not start, even one reading from its transcode folder",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const folder = yield* fs.makeTempDirectoryScoped({ prefix: "movies-tool-lifetime-" });
          const transcodeDir = path.join(folder, "transcode");
          const sleeper = yield* writeExecutable(path.join(folder, "ffmpeg.mjs"), sleeperScript);

          const reader = yield* spawner
            .spawn(
              ChildProcess.make(
                sleeper,
                ["-i", `${transcodeDir}/input.wav`, path.join(folder, "reader.pid")],
                { stdin: "ignore" },
              ),
            )
            .pipe(Effect.orDie);

          const scope = yield* Scope.make();

          yield* Layer.buildWithScope(
            MediaTestServer.layer({
              FFMPEG_PATH: sleeper,
              TRANSCODE_DIR: transcodeDir,
              DATA_DIR: path.join(folder, "data"),
            }),
            scope,
          );

          assert.isTrue(yield* reader.isRunning.pipe(Effect.orDie), "the unrelated ffmpeg runs on");
          yield* Scope.close(scope, Exit.void);
        }),
      60_000,
    );
  });
});
