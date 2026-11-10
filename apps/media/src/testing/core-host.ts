/**
 * Host-side helpers for the core stack suite that need Node directly: the CLI that reads the
 * core's ticket keys, a free port, and the work folder a test scans. This Effect-free leaf may
 * reject or throw; tests let that fail the test.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TICKET_KEYS_SETTING } from "@media/contracts/ticket";

const platformRoot = join(import.meta.dirname, "..", "..", "..", "..", "packages", "platform");

const convexCli = join(platformRoot, "node_modules", "convex", "bin", "main.js");

/** The core deployment's `MEDIA_TICKET_KEYS`, read with the CLI that set it; never logged. */
export const ticketKeysText = (): string =>
  execFileSync(process.execPath, [convexCli, "env", "get", TICKET_KEYS_SETTING], {
    cwd: platformRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const tryPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

/** A port nothing listens on now: a random one in 20000–39999 that a listen succeeds on. */
export const freePort = async (): Promise<number> => {
  const candidate = 20_000 + Math.floor(Math.random() * 20_000);

  return (await tryPort(candidate)) ? candidate : freePort();
};

/** A new empty folder under the system's temporary folder. */
export const makeWorkDir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

/** Removes a folder and everything in it. */
export const removeDir = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** A symbolic link at `path` to the folder `target`. */
export const linkFolder = (target: string, path: string): Promise<void> => symlink(target, path);

/** The SHA-256 of a file's bytes, in hex. */
export const fileDigest = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** The SHA-256 of `bytes`, in hex. */
export const bytesDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
