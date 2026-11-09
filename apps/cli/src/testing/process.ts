import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const packageRoot = join(import.meta.dirname, "..", "..");

const binary = join(packageRoot, "dist", "media.js");

/** Bundles the CLI so tests run the same file users install. */
export const buildCli = (): void => {
  execFileSync(process.execPath, [join(packageRoot, "scripts", "build.ts")]);
};

/** The outcome of one `media` invocation. */
export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A running `media` process whose stderr can be read line by line. */
export interface Running {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with the next stderr line. */
  readonly nextErrorLine: () => Promise<string>;
  readonly done: Promise<Run>;
}

/**
 * Starts the built CLI with only PATH plus `env` in its environment, feeding `stdin` if given.
 * `null` leaves stdin a pipe that never closes, as an agent's or a CI step's often is.
 */
export const startMovies = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  stdin: string | null = "",
): Running => {
  const child = spawn(process.execPath, [binary, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });

  let stdout = "";
  let stderr = "";
  const pending: Array<(line: string) => void> = [];
  const buffered: Array<string> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  createInterface({ input: child.stderr }).on("line", (line) => {
    stderr += `${line}\n`;
    const waiter = pending.shift();

    if (waiter === undefined) buffered.push(line);
    else waiter(line);
  });

  if (stdin !== null) child.stdin.end(stdin);

  const done = new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });

  const nextErrorLine = (): Promise<string> => {
    const line = buffered.shift();

    return line === undefined
      ? new Promise((resolve) => {
          pending.push(resolve);
        })
      : Promise.resolve(line);
  };

  return { child, nextErrorLine, done };
};

/** Runs the built CLI to completion. */
export const runMovies = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  stdin = "",
): Promise<Run> => startMovies(args, env, stdin).done;

/** Creates an empty temporary directory. */
export const makeTempDir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

/** Removes a directory tree. */
export const removeDir = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** The permission bits of a file, such as `0o600`. */
export const permissions = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

/** Reads a UTF-8 file, such as an install's config. */
export const readText = (path: string): Promise<string> => readFile(path, "utf8");

/** Replaces a file's contents, such as an install's config. */
export const writeText = (path: string, text: string): Promise<void> => writeFile(path, text);
