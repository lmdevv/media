/**
 * Effect operations over the file system for the media service, with typed failures. The Node
 * calls live in `platform/node-files.ts`; this module translates their rejections.
 */
import { Effect, Schema } from "effect";

import * as NodeFiles from "./platform/node-files.ts";

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

/** Streams the inclusive byte range of a file. Read errors surface through the stream itself. */
export const readRange = NodeFiles.readRange;
