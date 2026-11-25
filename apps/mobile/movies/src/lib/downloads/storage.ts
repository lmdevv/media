import { Result } from "effect";

import type { DiskFailed, DownloadDisk } from "./disk";
import { STORE_FILE } from "./files";
import { serializeStore } from "./model";
import type { DownloadStore } from "./model";

/** The file a new copy of `path` is written to before it replaces `path`. */
const nextOf = (path: string): string => `${path}.new`;

/**
 * Writes `text` to `path` so that a reader finds the old file or the new one, never part of one:
 * the text goes to a file beside it, which then moves over it. A write that fails leaves the old
 * file as it was, and deletes what it wrote.
 */
const replaceFile = (
  disk: DownloadDisk,
  path: string,
  text: string,
): Result.Result<void, DiskFailed> => {
  const next = nextOf(path);
  const written = disk.write(next, text);

  if (Result.isFailure(written)) {
    disk.remove(next);

    return written;
  }

  return disk.move(next, path);
};

/** Saves `store` as the downloads index, replacing the one there whole. */
export const saveIndex = (
  disk: DownloadDisk,
  store: DownloadStore,
): Result.Result<void, DiskFailed> => replaceFile(disk, STORE_FILE, serializeStore(store));

/**
 * The text of the downloads index: the index itself, else the new copy a save left when a crash
 * came after it deleted the old index and before the copy took its place. Null when there is
 * neither or it cannot be read.
 */
export const readIndexText = (disk: DownloadDisk): string | null =>
  Result.getOrNull(disk.read(STORE_FILE)) ?? Result.getOrNull(disk.read(nextOf(STORE_FILE)));
