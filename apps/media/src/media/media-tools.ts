import { Context, Duration, Effect, Layer, type Scope, Schema } from "effect";

import * as MediaConfig from "../media-config.ts";
import * as ScopedProcess from "../platform/scoped-process.ts";

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

/** A running ffmpeg whose file descriptor 3 is a pipe to the server (`pipe:3`). */
interface PipedTool {
  /**
   * The bytes ffmpeg writes to `pipe:3`, in order. ffmpeg waits while nobody reads it, so read it
   * to the end; ending the iteration early closes the pipe.
   */
  readonly output: AsyncIterable<Uint8Array>;
  /** Completes once ffmpeg exited and its pipes closed; fails as `ffmpeg` does. */
  readonly exit: Effect.Effect<void, MediaToolFailed>;
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
   * Starts ffmpeg in the current scope. Closing the scope kills it with `SIGKILL` and waits until
   * it has exited; its output is disposable. On Linux it also dies with the server.
   */
  readonly startFfmpeg: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<RunningTool, MediaToolFailed, Scope.Scope>;
  /**
   * Starts ffmpeg in the current scope with a pipe on file descriptor 3 for a stream it writes
   * there (`pipe:3`), as music's transcodes write theirs. `onStdout` gets standard output piece by
   * piece. Closing the scope kills it with `SIGKILL` and waits until it has exited; on Linux it
   * also dies with the server.
   */
  readonly startFfmpegPiped: (
    args: ReadonlyArray<string>,
    onStdout?: (text: string) => void,
  ) => Effect.Effect<PipedTool, MediaToolFailed, Scope.Scope>;
}

/** The media tools. */
export class Service extends Context.Service<Service, Interface>()("@media/server/MediaTools") {}

const STDERR_TAIL = 4096;

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
  const env = toolEnvironment(process.env);

  const spawn = Effect.fnUntraced(function* (
    tool: "ffmpeg" | "ffprobe",
    args: ReadonlyArray<string>,
    background: boolean = false,
    piped: { readonly onStdout: ((text: string) => void) | undefined } | null = null,
  ) {
    const failed = (exitCode: number | null, stderr: string, cause: unknown) =>
      new MediaToolFailed({ tool, exitCode, stderr: scrubPaths(stderr, args), cause });

    const program = tool === "ffmpeg" ? config.ffmpegPath : config.ffprobePath;

    const options = {
      env,
      background,
      stderrTail: STDERR_TAIL,
      stopSignal: "SIGKILL",
      forceKillAfter: "2 seconds",
      output: piped !== null,
      onStdout: piped?.onStdout,
    } as const;

    const running = yield* (
      process.platform === "linux"
        ? ScopedProcess.start("setpriv", dyingWithServer(program, args), options)
        : ScopedProcess.start(program, args, options)
    ).pipe(Effect.mapError((cause) => failed(null, "", cause)));

    const exit = Effect.gen(function* () {
      const { code, signal } = yield* Effect.promise(() => running.exited);

      // A stopped run fails as soon as it is reaped, which is when its slot is released.
      if (code === null) {
        return yield* failed(null, "", new Error(`${tool} was ended by ${String(signal)}`));
      }

      // Otherwise its output is read to the end first.
      yield* Effect.promise(() => running.closed);

      if (code !== 0) return yield* failed(code, running.stderrTail(), null);

      return running.stdout();
    });

    const suspend = (paused: boolean) =>
      Effect.sync(() => {
        running.signal(paused ? "SIGSTOP" : "SIGCONT");
      });

    return {
      exit,
      output: running.output,
      stderrTail: Effect.sync(() => scrubPaths(running.stderrTail(), args)),
      suspend,
    };
  });

  const runToCompletion = (tool: "ffmpeg" | "ffprobe", background: boolean) =>
    Effect.fn(`MediaTools.${tool}`)(function* (
      args: ReadonlyArray<string>,
      options: RunOptions = {},
    ) {
      const running = yield* spawn(tool, args, background);
      const timeout = options.timeout ?? (background ? undefined : config.probeTimeout);

      if (timeout === undefined) return yield* running.exit;

      // Leaving the scope on timeout kills the tool.
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
    const running = yield* spawn("ffmpeg", args);

    return {
      exit: Effect.asVoid(running.exit),
      stderrTail: running.stderrTail,
      suspend: running.suspend,
    } satisfies RunningTool;
  });

  const startFfmpegPiped = Effect.fn("MediaTools.startFfmpegPiped")(function* (
    args: ReadonlyArray<string>,
    onStdout?: (text: string) => void,
  ) {
    const running = yield* spawn("ffmpeg", args, false, { onStdout });

    const { output } = running;

    if (output === null) {
      return yield* new MediaToolFailed({
        tool: "ffmpeg",
        exitCode: null,
        stderr: "",
        cause: new Error("ffmpeg started without its output pipe"),
      });
    }

    return { output, exit: Effect.asVoid(running.exit) } satisfies PipedTool;
  });

  return Service.of({
    ffprobe: runToCompletion("ffprobe", false),
    ffmpeg: runToCompletion("ffmpeg", false),
    ffmpegInBackground: runToCompletion("ffmpeg", true),
    startFfmpeg,
    startFfmpegPiped,
  });
});

/** Media tools over Node's child processes. */
export const layer: Layer.Layer<Service, never, MediaConfig.Service> = Layer.effect(Service, make);
