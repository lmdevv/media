import { spawn } from "node:child_process";
import { setPriority } from "node:os";

/** How a tool's process ended: its exit code, or the signal that ended it. */
interface ToolExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A started tool's process. */
export interface ToolProcess {
  /** Resolves when Node reaps the process. */
  readonly exited: Promise<ToolExit>;
  /** Resolves once the process has exited and its output pipes have closed. */
  readonly closed: Promise<void>;
  readonly stdout: () => string;
  /** The last `stderrTail` characters of standard error. */
  readonly stderrTail: () => string;
  /** Signals the process until Node reaps it; afterwards it sends nothing. */
  readonly signal: (signal: "SIGKILL" | "SIGSTOP" | "SIGCONT") => void;
}

interface StartOptions {
  readonly env: Readonly<Record<string, string>>;
  /** Run at the lowest CPU priority. */
  readonly background: boolean;
  /** How many trailing characters of standard error to keep. */
  readonly stderrTail: number;
}

/** The nicest CPU priority on Unix systems. */
const LOWEST_PRIORITY = 19;

/**
 * Starts a tool's process and calls `onStarted` or `onFailed` once. Returns a function that kills
 * a process whose start is no longer wanted.
 *
 * Effect's child process spawner signals the numeric process group id when a run fails or its
 * scope closes, even after Node has reaped the process and an unrelated group may have taken the
 * id. Here the tool stays in the server's process group and is signalled only through Node's
 * `ChildProcess`, which drops its process handle when it reaps the process, on the same thread,
 * so a signal after that goes nowhere.
 */
export const startToolProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: StartOptions,
  onStarted: (process: ToolProcess) => void,
  onFailed: (error: Error) => void,
): (() => void) => {
  const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  // Node reaps children only from the event loop, which has not run since the spawn, so the pid
  // is still the tool's. Lowering a child's priority needs no privileges.
  if (options.background && child.pid !== undefined) {
    try {
      setPriority(child.pid, LOWEST_PRIORITY);
    } catch {
      // A platform that refuses runs the tool at normal priority.
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

  const exited = new Promise<ToolExit>((resolve) => {
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
