/**
 * Node file system primitives for the media service.
 *
 * Effect's `FileSystem` service is marked unstable in Effect 4.0.2, and the lint policy rejects
 * unstable Effect APIs while also rejecting `node:fs` inside Effect modules. These primitives
 * therefore live in this Effect-free leaf. Every function here may reject; `files.ts` is the
 * only caller and translates each rejection into a typed error.
 */
import { createReadStream } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { Readable } from "node:stream";

/** Size and modification time of one regular file. */
export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/** A regular file found while listing a directory. */
export interface ListedFile extends FileStat {
  readonly path: string;
}

/** Stats a path and reports whether it is a regular file. */
export const statPath = async (
  path: string,
): Promise<FileStat & { readonly kind: "file" | "directory" | "other" }> => {
  const info = await stat(path);
  const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";

  return { size: info.size, mtimeMs: info.mtimeMs, kind };
};

/** Streams the inclusive byte range `start..end` of a file as a web stream. */
export const readRange = (path: string, start: number, end: number): ReadableStream<Uint8Array> =>
  // SAFETY: `Readable.toWeb` is typed as `ReadableStream<any>`. A file read stream without an
  // `encoding` option emits only `Buffer` chunks, and `Buffer` is a `Uint8Array`.
  Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;

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

/** Reads up to `length` bytes from the start of a file. */
export const readHead = (path: string, length: number): Promise<Uint8Array> =>
  readAt(path, 0, length);

/** Reads a whole file. */
export const readWholeFile = (path: string): Promise<Uint8Array> => readFile(path);

/**
 * Writes bytes through a temporary sibling and a rename, so readers never see a partial file
 * and two writers of the same content cannot corrupt each other.
 */
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

/** Creates a directory and its parents. */
export const makeDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
};

/** Creates a symbolic link at `path` pointing to `target`. */
export const makeSymlink = (target: string, path: string): Promise<void> => symlink(target, path);

/** The canonical absolute path of an existing file or directory, with every symlink resolved. */
export const realPath = (path: string): Promise<string> => realpath(path);

/** Removes a file or directory tree; a missing path is not an error. */
export const removePath = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** Copies a directory tree, keeping modification times. */
export const copyTree = (from: string, to: string): Promise<void> =>
  cp(from, to, { recursive: true, preserveTimestamps: true });

/** Lists the names of the entries in one directory, or an empty list when it is missing. */
export const listNames = async (path: string): Promise<ReadonlyArray<string>> => {
  try {
    return await readdir(path);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

/** Lists the regular files directly inside a directory, with their sizes and times. */
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

/** A file found by `walkTree`, relative to the walk root with `/` separators. */
export interface WalkedFile extends FileStat {
  readonly relativePath: string;
}

/** True when the canonical `path` is the canonical `root` or lies under it. */
export const isWithin = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Folders a filesystem creates for itself. They are unreadable to non-root users and never hold music. */
const systemFolders: ReadonlySet<string> = new Set(["lost+found"]);

/**
 * Recursively lists regular files under `root` whose names pass `include`, skipping entries
 * whose names start with a dot and filesystem folders such as `lost+found`. A symlink to a file counts only when its target resolves inside
 * `root`, so a link cannot pull outside files into the library; symlinks to directories are never
 * followed, which also rules out loops. A folder that cannot be read fails the walk instead of
 * being skipped: skipping it would make every song under it look deleted. A folder that vanishes
 * mid-walk is skipped.
 */
export const walkTree = async (
  root: string,
  include: (name: string) => boolean,
): Promise<ReadonlyArray<WalkedFile>> => {
  const found: Array<WalkedFile> = [];

  // The root itself must exist; a missing root is an error the caller reports.
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
          if (systemFolders.has(entry.name)) return;
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

/** A folder in a library that the media service is not allowed to read. */
class UnreadableFolder extends Error {
  override readonly name = "UnreadableFolder";

  readonly path: string;

  constructor(path: string, cause: unknown) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "error";

    const reason =
      code === "EACCES" || code === "EPERM"
        ? `permission denied for the media service (uid ${process.getuid?.() ?? "unknown"})`
        : code;

    super(`Can't read ${path}: ${reason}`, { cause });
    this.path = path;
  }
}

/** True when a Node error means the path does not exist. */
export const isMissing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

/** Appends bytes to a file, creating it when missing. */
export const appendToFile = (path: string, data: Uint8Array): Promise<void> =>
  appendFile(path, data);
