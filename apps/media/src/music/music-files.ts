/**
 * The file operations music's scanner, art store, and transcoder run, as old music's media service
 * ran them (`files.ts`): the Effect-free `platform/node-files.ts` behind Effect, each failure a
 * `FileError` that says whether the path was missing. Music reads library folders only to walk and
 * read them, and writes only under the server's own data folder.
 */
import { Effect, Option, Schema } from "effect";

import * as NodeFiles from "./platform/node-files.ts";

export type { WalkedFile } from "./platform/node-files.ts";

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

/** Stats a path and says whether it is a regular file or a folder. */
export const statPath = (path: string) => attempt("stat", path, () => NodeFiles.statPath(path));

/** Reads up to `length` bytes of a file starting at byte `position`. */
export const readAt = (
  path: string,
  position: number,
  length: number,
): Effect.Effect<Uint8Array, FileError> =>
  attempt("read", path, () => NodeFiles.readAt(path, position, length));

/** Reads up to `length` bytes from the start of a file. */
export const readHead = (path: string, length: number): Effect.Effect<Uint8Array, FileError> =>
  readAt(path, 0, length);

/** Reads a whole file. */
export const readWholeFile = (path: string): Effect.Effect<Uint8Array, FileError> =>
  attempt("read", path, () => NodeFiles.readWholeFile(path));

/** Appends bytes to a file, creating it when missing. */
export const appendToFile = (path: string, data: Uint8Array): Effect.Effect<void, FileError> =>
  attempt("append", path, () => NodeFiles.appendToFile(path, data));

/**
 * Writes bytes through a temporary sibling and a rename, so readers never see a partial file and
 * two writers of the same content cannot corrupt each other.
 */
export const writeFileAtomic = (
  path: string,
  data: Uint8Array,
  temporarySuffix: string,
): Effect.Effect<void, FileError> =>
  attempt("write", path, () => NodeFiles.writeFileAtomic(path, data, temporarySuffix));

/** Renames a file, replacing the target. */
export const renameFile = (from: string, to: string): Effect.Effect<void, FileError> =>
  attempt("rename", from, () => NodeFiles.renameFile(from, to));

/** Creates a folder and its parents. */
export const makeDirectory = (path: string): Effect.Effect<void, FileError> =>
  attempt("mkdir", path, () => NodeFiles.makeDirectory(path));

/** Removes a file or a folder tree; a missing path succeeds. */
export const removePath = (path: string): Effect.Effect<void, FileError> =>
  attempt("remove", path, () => NodeFiles.removePath(path));

/** Lists the regular files directly inside a folder; a missing folder lists as empty. */
export const listFiles = (
  path: string,
): Effect.Effect<ReadonlyArray<NodeFiles.ListedFile>, FileError> =>
  attempt("list", path, () => NodeFiles.listFiles(path));

/** The canonical path of `path` through every link. Fails with `FileError` when it is missing. */
const realPath = (path: string): Effect.Effect<string, FileError> =>
  attempt("realpath", path, () => NodeFiles.realPath(path));

/**
 * The canonical path of `path` when it resolves, through any links, to somewhere inside the
 * canonical `root`; `None` when it escapes. Fails with `FileError` when either is missing.
 */
export const resolveWithin = (
  root: string,
  path: string,
): Effect.Effect<Option.Option<string>, FileError> =>
  Effect.all([realPath(root), realPath(path)]).pipe(
    Effect.map(([base, target]) =>
      NodeFiles.isWithin(base, target) ? Option.some(target) : Option.none(),
    ),
  );

/** Why a walk failed, as its scan reports it: the folder it could not read, or the root's error. */
export const walkFailureOf = (error: FileError): string =>
  error.cause instanceof NodeFiles.UnreadableFolder ? error.cause.message : error.message;

/**
 * Lists the regular files under `root` whose names pass `include`, as old music's walk did:
 * entries whose names start with a dot and file system folders such as `lost+found` are skipped.
 * A link to a file counts only when its target resolves inside `root`, so a link cannot pull
 * outside files into the library; links to folders are never followed, which also rules out
 * loops. A folder that cannot be read fails the walk instead of being skipped, since skipping it
 * would make every song under it look deleted. A folder that vanishes mid-walk is skipped.
 */
export const walkTree = (
  root: string,
  include: (name: string) => boolean,
): Effect.Effect<ReadonlyArray<NodeFiles.WalkedFile>, FileError> =>
  attempt("walk", root, () => NodeFiles.walk(root, include));
