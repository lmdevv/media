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
    stdio: ["ignore", "pipe", "pipe"],
  });

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

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
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
