/**
 * Starts a child process that is signalled only through Node's `ChildProcess` handle. Node drops
 * the handle when it reaps the process, on the same thread, so a signal after that goes nowhere:
 * the server never signals a process id or a process group id that may already belong to someone
 * else. Effect's child process spawner does: it signals the numeric process group id when a run
 * fails or its scope closes, even after the process was reaped. The child stays in the server's
 * process group. This Effect-free leaf reports through callbacks and promises; `scoped-process.ts`
 * wraps it for Effect callers.
 */
import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { Readable } from "node:stream";

/** How a process ended: its exit code, or the signal that ended it. */
interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A signal the server sends its own children. */
type ChildSignal = "SIGTERM" | "SIGKILL" | "SIGSTOP" | "SIGCONT";

/** A started child process. */
export interface RunningChild {
  /** Resolves when Node reaps the process. */
  readonly exited: Promise<ChildExit>;
  /** Resolves once the process has exited and its output pipes have closed. */
  readonly closed: Promise<void>;
  readonly stdout: () => string;
  /**
   * What the process writes to file descriptor 3 (ffmpeg's `pipe:3`), when `output` asked for
   * that pipe; null otherwise. Read it to the end: the process blocks once the pipe is full, and
   * `closed` waits for the pipe to close. Ending the iteration early destroys the pipe at once.
   */
  readonly output: AsyncIterable<Uint8Array> | null;
  /** The last `stderrTail` characters of standard error. */
  readonly stderrTail: () => string;
  /** Signals the process until Node reaps it; afterwards it sends nothing. */
  readonly signal: (signal: ChildSignal) => void;
}

/** How to start a child process. */
export interface ChildOptions {
  /** The child's whole environment; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Run at the lowest CPU priority. */
  readonly background?: boolean;
  /** How many trailing characters of standard error to keep. */
  readonly stderrTail: number;
  /** Open file descriptor 3 as a pipe to this process, for a tool that writes a stream there. */
  readonly output?: boolean | undefined;
  /**
   * Hands standard output to this callback piece by piece instead of keeping it for `stdout`, for
   * a long listing nobody needs whole.
   */
  readonly onStdout?: ((text: string) => void) | undefined;
}

/** The nicest CPU priority on Unix systems. */
const LOWEST_PRIORITY = 19;

/**
 * Starts `command` with standard input closed and calls `onStarted` or `onFailed` once. Returns a
 * function that kills a process whose start is no longer wanted.
 */
export const startChild = (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildOptions,
  onStarted: (child: RunningChild) => void,
  onFailed: (error: Error) => void,
): (() => void) => {
  const child = spawn(command, args, {
    env: options.env,
    cwd: options.cwd,
    stdio:
      options.output === true ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });

  const [, stdoutPipe, stderrPipe, outputPipe] = child.stdio;

  // Node opens a pipe for every "pipe" entry; its types cannot follow a computed list.
  if (!(stdoutPipe instanceof Readable) || !(stderrPipe instanceof Readable)) {
    child.kill("SIGKILL");
    throw new Error("spawn did not open the pipes it was asked for");
  }

  const output = outputPipe instanceof Readable ? bytesOf(outputPipe) : null;

  let stdout = "";
  let stderr = "";

  // Node reaps children only from the event loop, which has not run since the spawn, so the pid
  // is still the child's. Lowering a child's priority needs no privileges.
  if (options.background === true && child.pid !== undefined) {
    try {
      setPriority(child.pid, LOWEST_PRIORITY);
    } catch {
      // A platform that refuses runs the child at normal priority.
    }
  }

  const { onStdout } = options;

  stdoutPipe.setEncoding("utf8");
  stdoutPipe.on("data", (chunk: string) => {
    if (onStdout === undefined) stdout += chunk;
    else onStdout(chunk);
  });
  stderrPipe.setEncoding("utf8");
  stderrPipe.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-options.stderrTail);
  });

  const exited = new Promise<ChildExit>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  const closed = new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

  let reported = false;

  // A start that fails emits "error" and never "spawn". A later error, from a failed signal,
  // arrives after the start was reported and changes nothing.
  child.on("error", (error) => {
    if (reported) return;
    reported = true;
    onFailed(error);
  });

  child.on("spawn", () => {
    if (reported) return;
    reported = true;
    onStarted({
      exited,
      closed,
      stdout: () => stdout,
      output,
      stderrTail: () => stderr,
      signal: (signal) => {
        child.kill(signal);
      },
    });
  });

  return () => {
    child.kill("SIGKILL");
  };
};

async function* chunksOf(stream: Readable): AsyncGenerator<Uint8Array, void> {
  for await (const chunk of stream.iterator()) {
    if (chunk instanceof Uint8Array) yield chunk;
  }
}

/**
 * The chunks of a byte stream, where ending the iteration early (`return`) destroys the stream at
 * once. An async generator's `return` waits for its pending read, and a process that writes
 * nothing (a hung ffmpeg) never ends that read: whoever stops reading would wait as long, before
 * the process could even be killed.
 */
const bytesOf = (stream: Readable): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    const chunks = chunksOf(stream);

    return {
      next: () => chunks.next(),
      return: async () => {
        stream.destroy();

        return chunks.return();
      },
    };
  },
});
