import { lstat, mkdir, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A regular file as a scan reports it. */
export interface ScannedFile {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const entriesOf = async (folder: string) =>
  opendir(folder).catch((cause: unknown) => {
    if (isMissing(cause)) return null;

    throw cause;
  });

/**
 * Every regular file under `folder`, found with `opendir` and `lstat` only, so a walk never writes
 * to the tree. A folder that does not exist holds nothing.
 */
export const walk = async (folder: string): Promise<ReadonlyArray<ScannedFile>> => {
  const entries = await entriesOf(folder);

  if (entries === null) return [];

  const found: Array<Promise<ReadonlyArray<ScannedFile>>> = [];

  for await (const entry of entries) {
    const path = join(folder, entry.name);

    if (entry.isDirectory()) {
      found.push(walk(path));
    } else if (entry.isFile()) {
      found.push(
        lstat(path).then((stats) => [{ path, size: stats.size, mtime: Math.floor(stats.mtimeMs) }]),
      );
    }
  }

  return (await Promise.all(found)).flat();
};

/** Makes a folder under the system's temporary folder holding `files`, each with its own name. */
export const makeTree = async (files: ReadonlyArray<string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "media-library-"));

  await writeFiles(root, files);

  return root;
};

/** Writes `files` under `root`, each holding its own name. */
export const writeFiles = async (root: string, files: ReadonlyArray<string>): Promise<void> => {
  await Promise.all(
    files.map(async (file) => {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), file);
    }),
  );
};

/** Deletes `files` under `root`, or whole folders with everything in them. */
export const removeFiles = async (root: string, files: ReadonlyArray<string>): Promise<void> => {
  await Promise.all(files.map((file) => rm(join(root, file), { recursive: true, force: true })));
};

/** Deletes a folder `makeTree` made, with everything in it. */
export const removeTree = (root: string): Promise<void> =>
  rm(root, { recursive: true, force: true });
