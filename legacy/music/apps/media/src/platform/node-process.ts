/**
 * Runs a child process to completion. Effect's `ChildProcess` module is marked unstable in Effect
 * 4.0.2 and the lint policy rejects unstable Effect APIs and `node:child_process` in Effect
 * modules, so this Effect-free leaf owns the spawn. `ffmpeg.ts` translates its rejections.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

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

/** A running process whose file descriptor 3 is a pipe to this process. */
export interface PipedProcess {
  /**
   * Bytes the process writes to file descriptor 3, in order. Read it to the end: the process
   * blocks once the pipe is full, and `exit` waits for the pipe to close.
   */
  readonly output: AsyncIterable<Uint8Array>;
  /** Settles like `runProcess` once the process exits and its pipes close. */
  readonly exit: Promise<ProcessResult>;
}

/**
 * Spawns `command` like `runProcess`, with an extra pipe on file descriptor 3 for a tool that
 * writes a stream there (ffmpeg's `pipe:3`) while standard output stays free for text.
 */
export const spawnPiped = (
  command: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
): PipedProcess => {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    signal,
    killSignal: "SIGKILL",
  });

  const [, stdoutPipe, stderrPipe, outputPipe] = child.stdio;

  if (
    !(stdoutPipe instanceof Readable) ||
    !(stderrPipe instanceof Readable) ||
    !(outputPipe instanceof Readable)
  ) {
    throw new Error("spawn did not open the pipes it was asked for");
  }

  const exit = new Promise<ProcessResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    stdoutPipe.setEncoding("utf8");
    stderrPipe.setEncoding("utf8");
    stdoutPipe.on("data", (chunk: string) => {
      stdout += chunk;
    });

    stderrPipe.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });

    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });

  return { output: bytesOf(outputPipe), exit };
};

/** The chunks of a byte stream (one opened without an encoding, so every chunk is a `Buffer`). */
async function* bytesOf(stream: Readable): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream.iterator()) {
    if (chunk instanceof Uint8Array) yield chunk;
  }
}
