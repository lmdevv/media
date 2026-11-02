import { existsSync } from "node:fs";
import { readdir, readlink, realpath } from "node:fs/promises";

/** True where the process can list its descriptors (Linux). */
export const canCountOpenFiles = (): boolean => existsSync("/proc/self/fd");

/** How many descriptors of this process are open on the file at `path`. */
export const openDescriptors = async (path: string): Promise<number> => {
  const target = await realpath(path);
  const entries = await readdir("/proc/self/fd");

  const links = await Promise.all(
    entries.map((entry) => readlink(`/proc/self/fd/${entry}`).catch(() => null)),
  );

  return links.filter((link) => link === target).length;
};
