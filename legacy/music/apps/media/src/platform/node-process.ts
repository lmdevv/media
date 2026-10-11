/**
 * Runs a child process to completion. Effect's `ChildProcess` module is marked unstable in Effect
 * 4.0.2 and the lint policy rejects unstable Effect APIs and `node:child_process` in Effect
 * modules, so this Effect-free leaf owns the spawn. `ffmpeg.ts` translates its rejections.
 */
import { spawn } from "node:child_process";

/** Exit status and captured output of a finished process. */
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  /** The last few kilobytes of standard error, for diagnostics. */
  readonly stderr: string;
}

const STDERR_TAIL = 4096;

/**
 * Spawns `command` with `args` (no shell) and resolves when it exits. Aborting `signal` kills the
 * process with SIGKILL. Rejects when the process cannot start, for example when it is not found.
 */
export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGKILL",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });

    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
