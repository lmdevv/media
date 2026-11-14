/**
 * Node's file system calls that music's scanner, art store, and transcoder make, as old music's
 * media service made them (`platform/node-files.ts`). This Effect-free leaf answers with promises;
 * `music-files.ts` wraps it for Effect callers.
 */
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";

/** True when a Node error means the path does not exist. */
export const isMissing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

/** Size and modification time of one file. */
interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/** A regular file found while listing a directory. */
export interface ListedFile extends FileStat {
  readonly path: string;
}

/** A file found by `walkTree`, relative to the walk root with `/` separators. */
export interface WalkedFile extends FileStat {
  readonly relativePath: string;
}

/** Stats a path and says whether it is a regular file or a folder. */
export const statPath = async (path: string) => {
  const info = await stat(path);
  const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";

  return { size: info.size, mtimeMs: info.mtimeMs, kind } as const;
};

/** Reads up to `length` bytes of a file starting at byte `position`. */
export const readAt = async (
  path: string,
  position: number,
  length: number,
): Promise<Uint8Array> => {
  const handle = await open(path, "r");

  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** Reads a whole file. */
export const readWholeFile = (path: string): Promise<Uint8Array> => readFile(path);

/** Appends bytes to a file, creating it when missing. */
export const appendToFile = (path: string, data: Uint8Array): Promise<void> =>
  appendFile(path, data);

/** Writes bytes through a temporary sibling and a rename. */
export const writeFileAtomic = async (
  path: string,
  data: Uint8Array,
  temporarySuffix: string,
): Promise<void> => {
  const temporary = `${path}.${temporarySuffix}.part`;

  await writeFile(temporary, data);
  await rename(temporary, path);
};

/** Renames a file, replacing the target. */
export const renameFile = (from: string, to: string): Promise<void> => rename(from, to);

/** Creates a folder and its parents. */
export const makeDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
};

/** Removes a file or a folder tree; a missing path succeeds. */
export const removePath = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** Lists the regular files directly inside a folder; a missing folder lists as empty. */
export const listFiles = async (path: string): Promise<ReadonlyArray<ListedFile>> => {
  const entries = await readdir(path, { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissing(cause)) return [];
    throw cause;
  });

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = join(path, entry.name);
        const info = await stat(filePath).catch(() => null);

        return info === null ? null : { path: filePath, size: info.size, mtimeMs: info.mtimeMs };
      }),
  );

  return files.filter((file) => file !== null);
};

/** The canonical path of `path` through every link. */
export const realPath = (path: string): Promise<string> => realpath(path);

/** True when the canonical `path` is the canonical `root` or lies under it. */
export const isWithin = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** A folder a walk could not read; its message says why, for the scan's failure. */
export class UnreadableFolder extends Error {
  override readonly name = "UnreadableFolder";

  constructor(path: string, cause: unknown) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "error";

    const reason =
      code === "EACCES" || code === "EPERM"
        ? `permission denied for the media server (uid ${process.getuid?.() ?? "unknown"})`
        : code;

    super(`Can't read ${path}: ${reason}`, { cause });
  }
}

const SYSTEM_FOLDERS: ReadonlySet<string> = new Set(["lost+found"]);

/**
 * Lists the regular files under `root` whose names pass `include`; see `walkTree` in
 * `music-files.ts`.
 */
export const walk = async (
  root: string,
  include: (name: string) => boolean,
): Promise<ReadonlyArray<WalkedFile>> => {
  const found: Array<WalkedFile> = [];
  const rootInfo = await stat(root);

  if (!rootInfo.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const base = await realpath(root);

  const linkedFileInside = async (path: string): Promise<boolean> => {
    const target = await realpath(path).catch(() => null);

    return target !== null && isWithin(base, target);
  };

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: unknown) => {
      if (directory !== root && isMissing(cause)) return [];

      throw new UnreadableFolder(directory, cause);
    });

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".")) return;

        const absolute = join(directory, entry.name);
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

        if (entry.isDirectory()) {
          if (SYSTEM_FOLDERS.has(entry.name)) return;

          await visit(absolute, relative);

          return;
        }

        const candidate =
          entry.isFile() || (entry.isSymbolicLink() && (await linkedFileInside(absolute)));

        if (!candidate || !include(entry.name)) return;

        const info = await stat(absolute).catch(() => null);

        if (info?.isFile() === true) {
          found.push({ relativePath: relative, size: info.size, mtimeMs: info.mtimeMs });
        }
      }),
    );
  };

  await visit(root, "");

  return found;
};
