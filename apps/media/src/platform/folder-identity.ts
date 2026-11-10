/**
 * Folder identities for claiming library folders (ADR 0024): `<device>:<inode>` of a folder's real
 * path and of every folder above it. A link, a bind mount, or a case-insensitive or normalizing
 * mount shows one folder under another path, never under another identity. Identities hold only
 * within one boot, so the boot's id travels with them. This Effect-free leaf may reject; its
 * Effect callers translate that into typed errors.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

const BOOT_ID = "/proc/sys/kernel/random/boot_id";

const foldersUp = (path: string): ReadonlyArray<string> => {
  const parent = dirname(path);

  return parent === path ? [path] : [path, ...foldersUp(parent)];
};

/** The identity of `folder`'s real path and of each folder above it up to `/`, the folder first. */
export const folderChain = async (folder: string): Promise<ReadonlyArray<string>> => {
  const real = await realpath(folder);
  const stats = await Promise.all(foldersUp(real).map((path) => stat(path, { bigint: true })));

  return stats.map((info) => `${info.dev.toString()}:${info.ino.toString()}`);
};

/** This boot's id, or null where the system has none to read. */
export const bootId = async (): Promise<string | null> => {
  const text = await readFile(BOOT_ID, "utf8").catch(() => null);
  const trimmed = text?.trim() ?? "";

  return trimmed === "" ? null : trimmed;
};
