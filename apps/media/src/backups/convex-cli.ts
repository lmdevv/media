import { join } from "node:path";

import { Context, Effect, Fiber, Layer, Option, Redacted, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as MediaConfig from "../media-config.ts";

type Operation = "export" | "import" | "run";

class ConvexCliUnavailable extends Schema.TaggedError<ConvexCliUnavailable>()(
  "ConvexCliUnavailable",
  { missing: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Convex CLI unavailable: set ${this.missing.join(" and ")} to back up and restore`;
  }
}

class ConvexCliFailed extends Schema.TaggedError<ConvexCliFailed>()("ConvexCliFailed", {
  operation: Schema.Literals(["export", "import", "run"]),
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Convex CLI failed: ${this.operation} exited with ${String(this.exitCode)}: ${this.output.trim().slice(-400)}`;
  }
}

/** Failures of a CLI command. */
export type ConvexCliError = ConvexCliUnavailable | ConvexCliFailed;

/** The admin operations backups and restores need. */
export interface Interface {
  /** Exports every table and stored file into a new ZIP at `path`, which must not exist. */
  readonly exportSnapshot: (path: string) => Effect.Effect<void, ConvexCliError>;
  /** Replaces every table with the snapshot at `path`. */
  readonly importSnapshot: (path: string) => Effect.Effect<void, ConvexCliError>;
  /** Runs a function, internal ones included, with JSON arguments; returns its printed result. */
  readonly run: (
    functionName: string,
    args: Readonly<Record<string, string | number>>,
  ) => Effect.Effect<string, ConvexCliError>;
}

/** The Convex CLI. */
export class Service extends Context.Service<Service, Interface>()("@media/server/ConvexCli") {}

const OUTPUT_TAIL = 4096;

const scrub = (text: string, secrets: ReadonlyArray<string>): string =>
  secrets
    .filter((secret) => secret.length > 1)
    .toSorted((left, right) => right.length - left.length)
    .reduce((scrubbed, secret) => scrubbed.replaceAll(secret, "<redacted>"), text);

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const missing = [
    ...(Option.isNone(config.convexAdminKey) ? ["CONVEX_SELF_HOSTED_ADMIN_KEY"] : []),
    ...(Option.isNone(config.convexBackendDir) ? ["CONVEX_BACKEND_DIR"] : []),
    ...(Option.isNone(config.convexUrl) ? ["CONVEX_URL"] : []),
  ];

  const invoke = Effect.fn("ConvexCli.invoke")(
    function* (operation: Operation, args: ReadonlyArray<string>) {
      if (
        Option.isNone(config.convexAdminKey) ||
        Option.isNone(config.convexBackendDir) ||
        Option.isNone(config.convexUrl)
      ) {
        return yield* new ConvexCliUnavailable({ missing });
      }

      const backendDir = config.convexBackendDir.value;
      const adminKey = Redacted.value(config.convexAdminKey.value);
      const secrets = [adminKey, ...args.filter((arg) => arg.startsWith("/")), backendDir];

      const failed = (exitCode: number | null, output: string, cause: unknown) =>
        new ConvexCliFailed({ operation, exitCode, output: scrub(output, secrets), cause });

      const command = ChildProcess.make(
        process.execPath,
        [join(backendDir, "node_modules", "convex", "bin", "main.js"), ...args],
        {
          cwd: backendDir,
          env: {
            CONVEX_SELF_HOSTED_URL: config.convexUrl.value,
            CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
          },
          stdin: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: "5 seconds",
        },
      );

      const handle = yield* spawner
        .spawn(command)
        .pipe(Effect.mapError((cause) => failed(null, "", cause)));

      const output = yield* Ref.make("");

      const stdout = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.mapError((cause) => failed(null, "", cause)),
        Effect.forkScoped,
      );

      const stderr = yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(output, (tail) => (tail + chunk).slice(-OUTPUT_TAIL)),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );

      const code = yield* handle.exitCode.pipe(Effect.mapError((cause) => failed(null, "", cause)));
      const printed = yield* Fiber.join(stdout);

      yield* Fiber.join(stderr);

      if (code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* failed(code, `${yield* Ref.get(output)}${printed}`.slice(-OUTPUT_TAIL), null);
      }

      return printed.trim();
    },
    Effect.scoped,
    (effect, operation) => effect.pipe(Effect.annotateLogs({ convexCli: operation })),
  );

  return Service.of({
    exportSnapshot: (path) =>
      invoke("export", ["export", "--include-file-storage", "--path", path]).pipe(Effect.asVoid),
    importSnapshot: (path) =>
      invoke("import", ["import", "--replace-all", "--yes", "--format", "zip", path]).pipe(
        Effect.asVoid,
      ),
    run: (functionName, args) => invoke("run", ["run", functionName, JSON.stringify(args)]),
  });
});

/** The CLI over the platform's child process spawner. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Service, make);
