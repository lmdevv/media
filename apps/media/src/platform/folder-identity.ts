/**
 * Folder identities for claiming library folders (ADR 0024): `<device>:<inode>` of a folder's real
 * path and of every folder above it. A link, a bind mount, or a case-insensitive or normalizing
 * mount shows one folder under another path, never under another identity. A bind mount of a
 * folder's child, though, shows the child under a parent that is not the folder, so each folder
 * also has a source: the device it is on and its path within that device's file system, read from
 * the mount table, under which a child bound elsewhere still lies inside its folder. The boot's id
 * travels with the identities, for diagnostics. This Effect-free leaf may reject; its Effect
 * callers translate that into typed errors.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, posix } from "node:path";

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

const MOUNT_INFO = "/proc/self/mountinfo";

/** The most characters and segments a source path may have; longer ones are sent as no source. */
const SOURCE_CHARS_MAX = 4096;

const SOURCE_SEGMENTS_MAX = 64;

/** A folder's device and its path within that device's file system. */
export interface FolderSource {
  /** `<major>:<minor>`, as the mount table names the device. */
  readonly device: string;
  /** Absolute, "/" for the file system's root. */
  readonly path: string;
}

interface Mount {
  readonly device: string;
  readonly root: string;
  readonly point: string;
}

/** The mount table escapes space, tab, newline, and backslash as three octal digits. */
const unescape = (field: string): string =>
  field.replaceAll(/\\([0-7]{3})/gu, (_, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );

const parseMounts = (text: string): ReadonlyArray<Mount> =>
  text.split("\n").flatMap((line) => {
    const [, , device, root, point] = line.split(" ");

    return device === undefined || root === undefined || point === undefined
      ? []
      : [{ device, root: unescape(root), point: unescape(point) }];
  });

const within = (point: string, path: string): boolean =>
  point === "/" || path === point || path.startsWith(`${point}/`);

/**
 * The source of the folder at `real`, a real path: the innermost mount holding it, the last listed
 * when mounts stack on one point, and the folder's path below that mount's root.
 */
const sourceOf = (mounts: ReadonlyArray<Mount>, real: string): FolderSource | null => {
  const holding = mounts.reduce<Mount | null>(
    (best, mount) =>
      within(mount.point, real) && (best === null || mount.point.length >= best.point.length)
        ? mount
        : best,
    null,
  );

  if (holding === null) return null;

  const below = posix.relative(holding.point, real);
  const path = posix.join(holding.root, below);
  const segments = path.split("/").filter((segment) => segment.length > 0);

  return path.length > SOURCE_CHARS_MAX || segments.length > SOURCE_SEGMENTS_MAX
    ? null
    : { device: holding.device, path };
};

/** The source of the real path `real` under the mount table `mountInfo`, in its text form. */
export const sourceIn = (mountInfo: string, real: string): FolderSource | null =>
  sourceOf(parseMounts(mountInfo), real);

/** The source of `folder`, or null where the system has no mount table to read. */
export const folderSource = async (folder: string): Promise<FolderSource | null> => {
  const text = await readFile(MOUNT_INFO, "utf8").catch(() => null);

  return text === null ? null : sourceIn(text, await realpath(folder));
};
