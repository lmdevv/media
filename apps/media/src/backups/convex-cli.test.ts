import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Effect, Fiber, FileSystem, Layer, Path, Schedule } from "effect";

import { testConfigLayer } from "../testing/test-config.ts";
import * as ConvexCli from "./convex-cli.ts";

const ADMIN_KEY = "convex-self-hosted|secret";

// Stands in for the Convex CLI: `run <name> <json>` picks what it does.
const fakeCli = `import { writeFileSync } from "node:fs";
const [, name, json] = process.argv.slice(2);
const args = JSON.parse(json);
if (name === "environment") {
  process.stdout.write(JSON.stringify({ cwd: process.cwd(), names: Object.keys(process.env).sort() }) + "\\n");
} else if (name === "fail") {
  process.stderr.write("rejected " + process.env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  process.exit(2);
} else {
  if (args.ignoreTerm === 1) process.on("SIGTERM", () => {});
  writeFileSync(args.pidFile, String(process.pid));
  setInterval(() => {}, 60_000);
}
`;

/** The CLI layer over a backend folder holding the stand-in. */
const cliIn = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const backendDir = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "movies-convex-cli-" }),
  );

  const bin = path.join(backendDir, "node_modules", "convex", "bin");

  yield* fs.makeDirectory(bin, { recursive: true });
  yield* fs.writeFileString(path.join(bin, "main.js"), fakeCli);

  const built = yield* Layer.build(
    ConvexCli.layer.pipe(
      Layer.provide(
        testConfigLayer({
          CONVEX_SELF_HOSTED_ADMIN_KEY: ADMIN_KEY,
          CONVEX_BACKEND_DIR: backendDir,
          CONVEX_URL: "http://127.0.0.1:3210",
        }),
      ),
    ),
  );

  return { cli: Context.get(built, ConvexCli.Service), backendDir };
});

const gone = (pid: number) =>
  FileSystem.FileSystem.use((fs) => fs.exists(`/proc/${String(pid)}`)).pipe(
    Effect.map((exists) => !exists),
  );

/** Starts a CLI run that never ends, interrupts it, and returns its pid once the interrupt is done. */
const interruptedRun = Effect.fnUntraced(function* (ignoreTerm: 0 | 1) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { cli, backendDir } = yield* cliIn();
  const pidFile = path.join(backendDir, "cli.pid");
  const run = yield* Effect.forkChild(cli.run("hang", { pidFile, ignoreTerm }));

  const pid = yield* fs
    .readFileString(pidFile)
    .pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }), Effect.map(Number));

  yield* Fiber.interrupt(run);

  return pid;
});

describe.skipIf(process.platform !== "linux")("Convex CLI", () => {
  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect("runs in the backend folder with only its URL and admin key", () =>
      Effect.gen(function* () {
        const { cli, backendDir } = yield* cliIn();

        assert.strictEqual(
          yield* cli.run("environment", {}),
          JSON.stringify({
            cwd: backendDir,
            names: ["CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_SELF_HOSTED_URL"],
          }),
        );
      }),
    );

    it.effect("reports a failed command's exit code and output with the admin key redacted", () =>
      Effect.gen(function* () {
        const { cli } = yield* cliIn();
        const error = yield* Effect.flip(cli.run("fail", {}));

        assert.strictEqual(
          error.message,
          "Convex CLI failed: run exited with 2: rejected <redacted>",
        );
      }),
    );

    it.effect("a cancelled backup stops its CLI", () =>
      Effect.gen(function* () {
        assert.isTrue(yield* gone(yield* interruptedRun(0)), "the CLI is gone once cancelled");
      }),
    );

    it.effect(
      "a CLI that ignores SIGTERM is killed five seconds into the cancel",
      () =>
        Effect.gen(function* () {
          const started = Date.now();
          const pid = yield* interruptedRun(1);
          const took = Date.now() - started;

          assert.isTrue(yield* gone(pid), "the CLI is gone once cancelled");
          assert.isAtLeast(took, 5000, `the cancel took ${String(took)} ms`);
        }),
      20_000,
    );
  });
});
