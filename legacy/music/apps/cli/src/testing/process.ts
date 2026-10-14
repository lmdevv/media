/**
 * Test helpers that touch processes and files. They import nothing from Effect: Effect's
 * `FileSystem` and `ChildProcess` services are unstable, and the repo's lint rejects both them
 * and raw Node I/O inside Effect modules.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The package root, `apps/cli`. */
export const packageRoot = join(import.meta.dirname, "..", "..");

const binary = join(packageRoot, "dist", "music.js");

/** Bundles the CLI so tests run the same file users install. */
export const buildCli = (): void => {
  execFileSync(process.execPath, [join(packageRoot, "scripts", "build.ts")]);
};

/** The outcome of one `music` invocation. */
export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the built CLI with only PATH plus the given variables in its environment, and `stdin`
 * piped to its standard input (which is closed at once when there is none).
 */
export const runMusic = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  stdin = "",
): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
    });

    // A run that exits before reading stdin closes the pipe; that EPIPE is not a test failure.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });

/** Creates an empty temporary directory. */
export const makeTempDir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

/** Creates a directory with exactly `mode`, whatever the umask. */
export const makeDir = async (path: string, mode: number): Promise<void> => {
  await mkdir(path, { recursive: true });
  await chmod(path, mode);
};

/** Removes a directory tree. */
export const removeDir = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** Reads a UTF-8 file. */
export const readText = (path: string): Promise<string> => readFile(path, "utf8");

/** Writes a UTF-8 file. */
export const writeText = (path: string, text: string): Promise<void> => writeFile(path, text);

/** The permission bits of a file, such as `0o600`. */
export const permissions = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
