import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

const mediaRoot = join(repoRoot, "apps", "media");

const readEnvFile = (path: string): ReadonlyMap<string, string> => {
  if (!existsSync(path)) return new Map();

  return new Map(
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("=");

        return separator > 0
          ? [[line.slice(0, separator), line.slice(separator + 1)] as const]
          : [];
      }),
  );
};

/** Where the dev stack's core is, and its admin key. */
export interface CoreStack {
  readonly url: string;
  readonly adminKey: string;
}

/**
 * The core stack to test, or undefined unless `MEDIA_STACK_TESTS=1`.
 *
 * @throws When `MEDIA_STACK_TESTS=1` but no core stack is configured, a setup mistake.
 */
export const findCoreStack = (): CoreStack | undefined => {
  if (process.env["MEDIA_STACK_TESTS"] !== "1") return undefined;

  const platform = readEnvFile(join(repoRoot, "packages", "platform", ".env.local"));
  const url = platform.get("CONVEX_SELF_HOSTED_URL");
  const adminKey = platform.get("CONVEX_SELF_HOSTED_ADMIN_KEY");

  if (url === undefined || adminKey === undefined) {
    throw new Error(
      "MEDIA_STACK_TESTS=1 but no core stack is configured; run scripts/dev-stack.sh up",
    );
  }

  return { url, adminKey };
};

/** Bundles the media service so a test runs the file that ships. */
export const buildService = (): void => {
  execFileSync(process.execPath, [join(mediaRoot, "scripts", "build.ts")]);
};

/** A running media service process. */
export interface MediaProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Everything it logged so far, one JSON line per entry. */
  readonly logs: () => string;
  /** Stops it with `signal` and resolves when it exited. */
  readonly stop: (signal: NodeJS.Signals) => Promise<void>;
}

/** Starts the built media service with the stack's environment plus `env`. */
export const startMedia = (env: Readonly<Record<string, string>>): MediaProcess => {
  const child = spawn(
    process.execPath,
    ["--enable-source-maps", join(mediaRoot, "dist", "main.js")],
    { env: { PATH: process.env["PATH"] ?? "", ...env } },
  );

  let output = "";

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  const exited = new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

  return {
    child,
    logs: () => output,
    stop: async (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await exited;
    },
  };
};

/**
 * Polls `url` until `parse` accepts its body text, for up to `timeoutMs`, and returns what
 * `parse` made of it.
 */
export const waitForBody = async <A>(
  url: string,
  parse: (text: string) => A | undefined,
  timeoutMs: number,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;

  const attempt = async (): Promise<A> => {
    const text = await fetch(url)
      .then((response) => response.text())
      .catch(() => "");

    const parsed = parse(text);

    if (parsed !== undefined) return parsed;

    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    return attempt();
  };

  return attempt();
};

/** Creates an empty temporary directory. */
export const makeTempDir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

/** Removes a directory tree. */
export const removeDir = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** Writes `text` to a file. */
export const writeText = (path: string, text: string): Promise<void> => writeFile(path, text);

/** A file's size and permission bits, or undefined when it does not exist. */
export const fileInfo = (
  path: string,
): Promise<{ readonly size: number; readonly mode: number } | undefined> =>
  stat(path).then(
    (info) => ({ size: info.size, mode: info.mode & 0o777 }),
    () => undefined,
  );

/** Runs `command` (a program and its arguments), such as a service restart, and waits for it. */
export const runCommand = ([program = "false", ...args]: ReadonlyArray<string>): void => {
  execFileSync(program, args, { stdio: "ignore" });
};
