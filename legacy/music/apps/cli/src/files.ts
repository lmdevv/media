/**
 * File access for the config directory.
 *
 * Effect's `FileSystem` service is marked `@stability unstable`, and the repo's lint rejects
 * unstable APIs, so this adapter owns `node:fs` directly and imports nothing from Effect.
 * `config.ts` wraps every call and turns rejections into typed `ConfigFileError`s.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** Reads a UTF-8 file, resolving `null` when it does not exist. */
export const readTextFile = (path: string): Promise<string | null> =>
  readFile(path, "utf8").catch(async (cause: unknown) => {
    if (isMissing(cause)) return null;

    throw cause instanceof Error ? cause : new Error(`Could not read ${path}`, { cause });
  });

/**
 * Writes a file readable only by the current user (mode 0600) inside a 0700 directory. The write
 * goes to a temporary file first so a crash never leaves half a config behind.
 */
export const writePrivateFile = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temporary = `${path}.${String(process.pid)}.tmp`;

  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  // The process umask can widen the creation mode; set it explicitly.
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

/** Deletes a file if it exists. */
export const removeFile = (path: string): Promise<void> => rm(path, { force: true });
