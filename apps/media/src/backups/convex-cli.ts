import { join } from "node:path";

import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import * as MediaConfig from "../media-config.ts";
import * as ScopedProcess from "../platform/scoped-process.ts";

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

/** The deployment the CLI administers, and the setting that names each part when it is absent. */
interface Target {
  readonly url: Option.Option<string>;
  readonly adminKey: Option.Option<Redacted.Redacted>;
  readonly backendDir: Option.Option<string>;
  readonly names: { readonly url: string; readonly adminKey: string; readonly backendDir: string };
}

const makeFor = (target: Target): Interface => {
  const missing = [
    ...(Option.isNone(target.adminKey) ? [target.names.adminKey] : []),
    ...(Option.isNone(target.backendDir) ? [target.names.backendDir] : []),
    ...(Option.isNone(target.url) ? [target.names.url] : []),
  ];

  const invoke = Effect.fn("ConvexCli.invoke")(
    function* (operation: Operation, args: ReadonlyArray<string>) {
      if (
        Option.isNone(target.adminKey) ||
        Option.isNone(target.backendDir) ||
        Option.isNone(target.url)
      ) {
        return yield* new ConvexCliUnavailable({ missing });
      }

      const backendDir = target.backendDir.value;
      const adminKey = Redacted.value(target.adminKey.value);
      const secrets = [adminKey, ...args.filter((arg) => arg.startsWith("/")), backendDir];

      const failed = (exitCode: number | null, output: string, cause: unknown) =>
        new ConvexCliFailed({ operation, exitCode, output: scrub(output, secrets), cause });

      // Closing the scope, as a cancelled backup does, stops the CLI: SIGTERM, then SIGKILL.
      const child = yield* ScopedProcess.start(
        process.execPath,
        [join(backendDir, "node_modules", "convex", "bin", "main.js"), ...args],
        {
          cwd: backendDir,
          env: {
            CONVEX_SELF_HOSTED_URL: target.url.value,
            CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
          },
          stderrTail: OUTPUT_TAIL,
          stopSignal: "SIGTERM",
          forceKillAfter: "5 seconds",
        },
      ).pipe(Effect.mapError((cause) => failed(null, "", cause)));

      const { code, signal } = yield* Effect.promise(() => child.exited);

      if (code === null) {
        return yield* failed(null, "", new Error(`the CLI was ended by ${String(signal)}`));
      }

      yield* Effect.promise(() => child.closed);

      const printed = child.stdout();

      if (code !== 0) {
        return yield* failed(code, `${child.stderrTail()}${printed}`.slice(-OUTPUT_TAIL), null);
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
};

/** The CLI as a Node child process of the server, for the core's deployment. */
export const layer: Layer.Layer<Service, never, MediaConfig.Service> = Layer.effect(
  Service,
  Effect.map(MediaConfig.Service, (config) =>
    makeFor({
      url: config.convexUrl,
      adminKey: config.convexAdminKey,
      backendDir: config.convexBackendDir,
      names: {
        url: "CONVEX_URL",
        adminKey: "CONVEX_SELF_HOSTED_ADMIN_KEY",
        backendDir: "CONVEX_BACKEND_DIR",
      },
    }),
  ),
);
