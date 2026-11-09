import { type Duration, Effect, Option, type Scope } from "effect";

import { type ChildOptions, type RunningChild, startChild } from "./node-child-process.ts";

/** How a scoped process stops when its scope closes. */
interface StopOptions {
  /** Sent first. */
  readonly stopSignal: "SIGTERM" | "SIGKILL";
  /** A process still running this long after `stopSignal` gets `SIGKILL`. */
  readonly forceKillAfter: Duration.Input;
}

const stop = (child: RunningChild, options: StopOptions) =>
  Effect.gen(function* () {
    const exited = Effect.promise(() => child.exited);

    yield* Effect.sync(() => child.signal(options.stopSignal));

    if (Option.isSome(yield* exited.pipe(Effect.timeoutOption(options.forceKillAfter)))) return;

    yield* Effect.sync(() => child.signal("SIGKILL"));
    yield* exited;
  });

/**
 * Starts a child process in the current scope; see `node-child-process.ts`. Closing the scope
 * sends `stopSignal`, then `SIGKILL` to a process still running `forceKillAfter` later, and
 * returns once Node has reaped it. A process that has already exited is sent nothing.
 */
export const start = (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildOptions & StopOptions,
): Effect.Effect<RunningChild, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<RunningChild, Error>((resume) => {
      const abandon = startChild(
        command,
        args,
        options,
        (child) => {
          resume(Effect.succeed(child));
        },
        (error) => {
          resume(Effect.fail(error));
        },
      );

      return Effect.sync(abandon);
    }),
    (child) => stop(child, options),
  );
