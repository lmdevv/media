import { setPriority } from "node:os";

import { Context, Duration, Effect, Fiber, Layer, Ref, type Scope, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as MediaConfig from "../media-config.ts";

/** A media tool could not start, or exited unsuccessfully. */
export class MediaToolFailed extends Schema.TaggedError<MediaToolFailed>()("MediaToolFailed", {
  tool: Schema.Literals(["ffmpeg", "ffprobe"]),
  exitCode: Schema.NullOr(Schema.Int),
  /** Tail of the tool's standard error with absolute paths from its arguments replaced. */
  stderr: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Media tool failed: ${this.tool} exited with ${String(this.exitCode)}: ${this.stderr.trim().slice(-400)}`;
  }
}

interface RunningTool {
  readonly exit: Effect.Effect<void, MediaToolFailed>;
  readonly stderrTail: Effect.Effect<string>;
  readonly suspend: (paused: boolean) => Effect.Effect<void>;
}

interface RunOptions {
  readonly timeout?: Duration.Duration;
}

/** ffprobe and ffmpeg. */
export interface Interface {
  /**
   * Runs ffprobe to completion and returns its standard output. A run that takes longer than its
   * timeout is killed and fails with `MediaToolFailed` (exit code `null`).
   */
  readonly ffprobe: (
    args: ReadonlyArray<string>,
    options?: RunOptions,
  ) => Effect.Effect<string, MediaToolFailed>;
  /** Runs ffmpeg to completion and returns its standard output; times out as `ffprobe` does. */
  readonly ffmpeg: (
    args: ReadonlyArray<string>,
    options?: RunOptions,
  ) => Effect.Effect<string, MediaToolFailed>;
  /**
   * Runs ffmpeg to completion at the lowest CPU priority, for background work such as scrub
   * thumbnails that must never slow down playback.
   */
  readonly ffmpegInBackground: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, MediaToolFailed>;
  /**
   * Starts ffmpeg in the current scope. Closing the scope kills the whole process group with
   * `SIGKILL`; its output is disposable. On Linux it also dies with the server.
   */
  readonly startFfmpeg: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<RunningTool, MediaToolFailed, Scope.Scope>;
}

/** The media tools. */
export class Service extends Context.Service<Service, Interface>()("@media/server/MediaTools") {}

const STDERR_TAIL = 4096;

/** The nicest CPU priority on Unix systems. */
const LOWEST_PRIORITY = 19;

/**
 * Starts a tool so it dies with the server, even by SIGKILL. util-linux `setpriv` sets the
 * parent-death signal, then a shell checks its parent is still the server, since a server that
 * died before the signal was set sends none, and becomes the tool. Each step keeps the pid. The
 * signal follows the thread that spawned the tool: Node spawns from its main thread, which lives
 * as long as the server.
 */
const dyingWithServer = (program: string, args: ReadonlyArray<string>) => [
  "--pdeathsig",
  "KILL",
  "--",
  "/bin/sh",
  "-c",
  '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"',
  "sh",
  String(process.pid),
  program,
  ...args,
];

const scrubPaths = (text: string, args: ReadonlyArray<string>): string =>
  args
    .filter((arg) => arg.startsWith("/") && arg.length > 1)
    .toSorted((left, right) => right.length - left.length)
    .reduce((scrubbed, path) => scrubbed.replaceAll(path, "<path>"), text);

/**
 * Variables ffmpeg and ffprobe may see: where programs live, time and locale, and where VA-API
 * drivers and the oneVPL runtime are (Quick Sync). Everything else stays out, above all the
 * Convex admin key and the service's credentials, so a crafted file that exploits a decoder finds
 * nothing to steal.
 */
const TOOL_ENVIRONMENT = [
  "PATH",
  "TZ",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "LIBVA_DRIVERS_PATH",
  "LIBVA_DRIVER_NAME",
  "ONEVPL_SEARCH_PATH",
] as const;

/** The environment the tools run with, picked from the service's own. */
export const toolEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    TOOL_ENVIRONMENT.flatMap((name) => {
      const value = environment[name];

      return value === undefined ? [] : [[name, value]];
    }),
  );

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = toolEnvironment(process.env);

  const spawn = Effect.fnUntraced(function* (
    tool: "ffmpeg" | "ffprobe",
    args: ReadonlyArray<string>,
    killSignal: "SIGKILL" | "SIGTERM",
    background: boolean = false,
  ) {
    const failed = (exitCode: number | null, stderr: string, cause: unknown) =>
      new MediaToolFailed({ tool, exitCode, stderr: scrubPaths(stderr, args), cause });

    const program = tool === "ffmpeg" ? config.ffmpegPath : config.ffprobePath;
    const options = { env, stdin: "ignore", killSignal, forceKillAfter: "2 seconds" } as const;

    const command =
      process.platform === "linux"
        ? ChildProcess.make("setpriv", dyingWithServer(program, args), options)
        : ChildProcess.make(program, args, options);

    const handle = yield* spawner
      .spawn(command)
      .pipe(Effect.mapError((cause) => failed(null, "", cause)));

    // Lowering a child's priority needs no privileges; a platform that refuses runs it as is.
    if (background)
      yield* Effect.try(() => setPriority(handle.pid, LOWEST_PRIORITY)).pipe(Effect.ignore);

    const stderr = yield* Ref.make("");

    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(stderr, (tail) => (tail + chunk).slice(-STDERR_TAIL)),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );

    const stdout = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError((cause) => failed(null, "", cause)),
      Effect.forkScoped,
    );

    const exit = Effect.gen(function* () {
      const code = yield* handle.exitCode.pipe(Effect.mapError((cause) => failed(null, "", cause)));

      if (code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* failed(code, yield* Ref.get(stderr), null);
      }

      return yield* Fiber.join(stdout);
    });

    // Once the run exits, its PID may belong to another process.
    const suspend = (paused: boolean) =>
      handle.isRunning.pipe(
        Effect.flatMap((running) =>
          running
            ? Effect.try(() => process.kill(handle.pid, paused ? "SIGSTOP" : "SIGCONT"))
            : Effect.void,
        ),
        Effect.ignore,
      );

    return {
      exit,
      stderrTail: Ref.get(stderr).pipe(Effect.map((text) => scrubPaths(text, args))),
      suspend,
    };
  });

  const runToCompletion = (tool: "ffmpeg" | "ffprobe", background: boolean) =>
    Effect.fn(`MediaTools.${tool}`)(function* (
      args: ReadonlyArray<string>,
      options: RunOptions = {},
    ) {
      const running = yield* spawn(tool, args, "SIGKILL", background);
      const timeout = options.timeout ?? (background ? undefined : config.probeTimeout);

      if (timeout === undefined) return yield* running.exit;

      // Leaving the scope on timeout kills the process group.
      return yield* running.exit.pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new MediaToolFailed({
                tool,
                exitCode: null,
                stderr: `timed out after ${String(Duration.toSeconds(timeout))} seconds`,
                cause: null,
              }),
            ),
        }),
      );
    }, Effect.scoped);

  const startFfmpeg = Effect.fn("MediaTools.startFfmpeg")(function* (args: ReadonlyArray<string>) {
    const running = yield* spawn("ffmpeg", args, "SIGKILL");

    return {
      exit: Effect.asVoid(running.exit),
      stderrTail: running.stderrTail,
      suspend: running.suspend,
    } satisfies RunningTool;
  });

  return Service.of({
    ffprobe: runToCompletion("ffprobe", false),
    ffmpeg: runToCompletion("ffmpeg", false),
    ffmpegInBackground: runToCompletion("ffmpeg", true),
    startFfmpeg,
  });
});

/** Media tools over the platform's child process spawner. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Service, make);
