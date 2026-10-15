/**
 * Effect operations over the file system for the media service, with typed failures. The Node
 * calls live in `platform/node-files.ts`; this module translates their rejections.
 */
import { Effect, Option, Schema } from "effect";

import { type Mount, parseMountinfo } from "./mounts.ts";
import * as NodeFiles from "./platform/node-files.ts";

/** The mount table of the service's own mount namespace. */
const MOUNTINFO = "/proc/self/mountinfo";

/** The kernel's identity for this boot. */
const BOOT_ID = "/proc/sys/kernel/random/boot_id";

/** A file system operation failed. `missing` is true when the path does not exist. */
export class FileError extends Schema.TaggedError<FileError>()("FileError", {
  operation: Schema.String,
  path: Schema.String,
  missing: Schema.Boolean,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `File operation failed: ${this.operation} ${this.path}${this.missing ? " (missing)" : ""}`;
  }
}

const attempt = <A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, FileError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new FileError({ operation, path, missing: NodeFiles.isMissing(cause), cause }),
  });

/** Stats a path. */
export const statPath = (
  path: string,
): Effect.Effect<
  NodeFiles.FileStat & { readonly kind: "file" | "directory" | "other" },
  FileError
> => attempt("stat", path, () => NodeFiles.statPath(path));

/** Reads up to `length` bytes from the start of a file. */
export const readHead = (path: string, length: number): Effect.Effect<Uint8Array, FileError> =>
  attempt("readHead", path, () => NodeFiles.readHead(path, length));

/** Reads up to `length` bytes of a file starting at byte `position`. */
export const readAt = (
  path: string,
  position: number,
  length: number,
): Effect.Effect<Uint8Array, FileError> =>
  attempt("read", path, () => NodeFiles.readAt(path, position, length));

/** Appends bytes to a file, creating it when missing. */
export const appendToFile = (path: string, data: Uint8Array): Effect.Effect<void, FileError> =>
  attempt("append", path, () => NodeFiles.appendToFile(path, data));

/** Reads a whole file. */
export const readWholeFile = (path: string): Effect.Effect<Uint8Array, FileError> =>
  attempt("read", path, () => NodeFiles.readWholeFile(path));

/** Writes bytes atomically through a temporary sibling and a rename. */
export const writeFileAtomic = (
  path: string,
  data: Uint8Array,
  temporarySuffix: string,
): Effect.Effect<void, FileError> =>
  attempt("write", path, () => NodeFiles.writeFileAtomic(path, data, temporarySuffix));

/** Renames a file, replacing the target. */
export const renameFile = (from: string, to: string): Effect.Effect<void, FileError> =>
  attempt("rename", from, () => NodeFiles.renameFile(from, to));

/** Creates a directory and its parents. */
export const makeDirectory = (path: string): Effect.Effect<void, FileError> =>
  attempt("mkdir", path, () => NodeFiles.makeDirectory(path));

/** Creates a symbolic link at `path` pointing to `target`. */
export const makeSymlink = (target: string, path: string): Effect.Effect<void, FileError> =>
  attempt("symlink", path, () => NodeFiles.makeSymlink(target, path));

/** Removes a file or directory tree; a missing path succeeds. */
export const removePath = (path: string): Effect.Effect<void, FileError> =>
  attempt("remove", path, () => NodeFiles.removePath(path));

/** Copies a directory tree, keeping modification times. */
export const copyTree = (from: string, to: string): Effect.Effect<void, FileError> =>
  attempt("copy", from, () => NodeFiles.copyTree(from, to));

/** Lists entry names in a directory; a missing directory lists as empty. */
export const listNames = (path: string): Effect.Effect<ReadonlyArray<string>, FileError> =>
  attempt("list", path, () => NodeFiles.listNames(path));

/** Lists regular files directly inside a directory; a missing directory lists as empty. */
export const listFiles = (
  path: string,
): Effect.Effect<ReadonlyArray<NodeFiles.ListedFile>, FileError> =>
  attempt("list", path, () => NodeFiles.listFiles(path));

/** Recursively lists non-hidden regular files under `root` whose names pass `include`. */
export const walkTree = (
  root: string,
  include: (name: string) => boolean,
): Effect.Effect<ReadonlyArray<NodeFiles.WalkedFile>, FileError> =>
  attempt("walk", root, () => NodeFiles.walkTree(root, include));

/** The canonical path of `path` through every link. Fails with `FileError` when it does not exist. */
export const realPath = (path: string): Effect.Effect<string, FileError> =>
  attempt("realpath", path, () => NodeFiles.realPath(path));

/**
 * The service's mount table (`/proc/self/mountinfo`, see `mounts.ts`), or null where there is
 * none to read (not Linux).
 */
export const readMounts: Effect.Effect<ReadonlyArray<Mount> | null> = attempt(
  "read",
  MOUNTINFO,
  () => NodeFiles.readWholeFile(MOUNTINFO),
).pipe(
  Effect.map((bytes) => parseMountinfo(new TextDecoder().decode(bytes))),
  Effect.orElseSucceed(() => null),
);

/**
 * This boot of the machine (`/proc/sys/kernel/random/boot_id`), or null where there is none (not
 * Linux). Device numbers and inodes can change or be reused across reboots, so folder identities
 * are compared only within one boot.
 */
export const readBootId: Effect.Effect<string | null> = attempt("read", BOOT_ID, () =>
  NodeFiles.readWholeFile(BOOT_ID),
).pipe(
  Effect.map((bytes) => new TextDecoder().decode(bytes).trim() || null),
  Effect.orElseSucceed(() => null),
);

/** A folder's identity and its parents' up to `/`, the folder first (`NodeFiles.folderIds`). */
export const folderIds = (path: string): Effect.Effect<ReadonlyArray<string>, FileError> =>
  attempt("stat", path, () => NodeFiles.folderIds(path));

/**
 * The canonical path of `path` when it resolves, through any symlinks, to somewhere inside the
 * canonical `root`; `None` when it escapes. Fails with `FileError` when either does not exist.
 */
export const resolveWithin = (
  root: string,
  path: string,
): Effect.Effect<Option.Option<string>, FileError> =>
  Effect.all([
    attempt("realpath", root, () => NodeFiles.realPath(root)),
    attempt("realpath", path, () => NodeFiles.realPath(path)),
  ]).pipe(
    Effect.map(([base, target]) =>
      NodeFiles.isWithin(base, target) ? Option.some(target) : Option.none(),
    ),
  );

/**
 * Streams the inclusive byte range of a file, closing it once `signal` aborts. Read errors surface
 * through the stream itself.
 */
export const readRange = NodeFiles.readRange;
