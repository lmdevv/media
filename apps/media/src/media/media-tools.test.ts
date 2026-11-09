import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Context, Duration, Effect, Exit, FileSystem, Layer, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { testConfigLayer } from "../testing/test-config.ts";
import * as MediaTools from "./media-tools.ts";

const toolsLayer = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({ FFPROBE_PATH: "/usr/bin/env" })),
  Layer.provide(NodeServices.layer),
);

// Node stands in for ffmpeg: `-e` runs a script with the arguments after `--`.
const nodeLayer = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({ FFMPEG_PATH: process.execPath })),
  Layer.provide(NodeServices.layer),
);

const hangingLayer = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({ FFMPEG_PATH: "sleep", PROBE_TIMEOUT_SECONDS: "1" })),
  Layer.provideMerge(NodeServices.layer),
);

const reusingPid = (pid: ChildProcessSpawner.ProcessId) =>
  Layer.fresh(MediaTools.layer).pipe(
    Layer.provide(testConfigLayer({ FFMPEG_PATH: "sleep" })),
    Layer.provide(
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (real) =>
          ChildProcessSpawner.make((command) =>
            real
              .spawn(command)
              .pipe(Effect.map((handle) => ChildProcessSpawner.makeHandle({ ...handle, pid }))),
          ),
        ),
      ),
    ),
  );

const stopped = Effect.fnUntraced(function* (pid: ChildProcessSpawner.ProcessId) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.readFileString(`/proc/${String(pid)}/stat`);

  return stat.slice(stat.lastIndexOf(")") + 2).startsWith("T");
});

const running = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const wanted = args.join("\0");
  const pids = (yield* fs.readDirectory("/proc")).filter((name) => /^\d+$/.test(name));

  const commands = yield* Effect.forEach(pids, (pid) =>
    fs.readFileString(`/proc/${pid}/cmdline`).pipe(Effect.orElseSucceed(() => "")),
  );

  return commands.some((cmdline) => cmdline.replace(/\0$/, "").endsWith(wanted));
});

describe("media tools", () => {
  it("passes on only the variables the tools need", () => {
    assert.deepStrictEqual(
      MediaTools.toolEnvironment({
        PATH: "/usr/bin",
        LIBVA_DRIVERS_PATH: "/run/opengl-driver/lib/dri",
        MEDIA_SERVICE_API_KEY: "mk_service_secret",
        CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-self-hosted|secret",
        PLAYBACK_TOKEN_SECRET: "secret",
        TZ: undefined,
      }),
      { PATH: "/usr/bin", LIBVA_DRIVERS_PATH: "/run/opengl-driver/lib/dri" },
    );
  });

  layer(toolsLayer)((tools) => {
    tools.effect("runs the tools without the service's credentials", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;
        const listed = yield* service.ffprobe([]);

        const names = listed
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => line.slice(0, line.indexOf("=")));

        assert.include(names, "PATH");
        assert.notInclude(names, "MEDIA_SERVICE_API_KEY");
        assert.isTrue(names.every((name) => !name.includes("KEY") && !name.includes("SECRET")));
      }),
    );
  });

  layer(nodeLayer)((tools) => {
    tools.effect("hands a tool its arguments exactly as given", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;
        const args = ["-x", "a b", `it's "quoted"`, "--", "$HOME", "*", "", "-c"];

        const echoed = yield* service.ffmpeg([
          "-e",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          "--",
          ...args,
        ]);

        assert.strictEqual(echoed, JSON.stringify(args));
      }),
    );

    tools.effect("reports a failed tool's exit code and standard error", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;

        const failure = yield* service
          .ffmpeg([
            "-e",
            "process.stderr.write(`no decoder for ${process.argv[1]}`); process.exit(3)",
            "--",
            "/media/films/a b.mkv",
          ])
          .pipe(Effect.flip);

        assert.strictEqual(failure.exitCode, 3);
        assert.strictEqual(failure.stderr, "no decoder for <path>");
      }),
    );
  });

  layer(hangingLayer, { excludeTestServices: true })((tools) => {
    tools.effect("kills a run that outlives its timeout", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;
        const marker = ["86399.25"];
        const exit = yield* service.ffmpeg(marker).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "timed out after 1 seconds");

        const shorter = yield* service
          .ffmpeg(["86399.5"], { timeout: Duration.millis(200) })
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(shorter));
        assert.isFalse(yield* running(marker));
      }),
    );

    tools.effect("never signals the process that took over a finished run's PID", () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const bystander = yield* spawner.spawn(
          ChildProcess.make("sleep", ["30"], { stdin: "ignore", killSignal: "SIGKILL" }),
        );

        const signalled = stopped(bystander.pid).pipe(
          Effect.repeat({
            until: (state) => state,
            schedule: Schedule.spaced("20 millis"),
            times: 50,
          }),
        );

        const reused = yield* Layer.build(reusingPid(bystander.pid));
        const run = yield* Context.get(reused, MediaTools.Service).startFfmpeg(["0.3"]);

        yield* run.suspend(true);
        assert.isTrue(yield* signalled, "a running run's suspend reaches its PID");
        yield* run.suspend(false);

        yield* run.exit;
        yield* run.suspend(true);
        yield* Effect.sleep(Duration.millis(300));

        assert.isFalse(yield* stopped(bystander.pid), "a finished run sends nothing");
      }),
    );

    tools.effect("lets background work run past the probe timeout", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;

        assert.isTrue(Exit.isSuccess(yield* service.ffmpegInBackground(["1.5"]).pipe(Effect.exit)));
      }),
    );
  });
});
