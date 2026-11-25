import { Data, Option, Result } from "effect";

import type { DiskFailed, DownloadDisk } from "./disk";
import { RECORD_FILE, STORE_FILE, UNREADABLE_STORE_FILE, itemFolder, itemPath } from "./files";
import { EMPTY_STORE, parseRecord, parseStore, serializeRecord, serializeStore } from "./model";
import type { DownloadRecord, DownloadStore } from "./model";

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

/** What reading the downloads index found. */
export type IndexRead = Data.TaggedEnum<{
  /** Nothing in the person's folder: their first launch with this server here. */
  None: {};
  /** The index read. */
  Readable: { readonly store: DownloadStore };
  /**
   * No copy of the index read, or there is none beside the downloads' folders. `recovered` holds
   * the downloads rebuilt from their own copies of their rows.
   */
  Unreadable: { readonly recovered: DownloadStore };
}>;

/** Constructors and matchers for `IndexRead`. */
export const IndexRead = Data.taggedEnum<IndexRead>();

const storeAt = (disk: DownloadDisk, path: string): Option.Option<DownloadStore> =>
  Option.flatMap(Option.fromNullishOr(Result.getOrNull(disk.read(path))), parseStore);

/** The download whose own copy of its row is in the folder `name`, when it reads as that one. */
const recordIn = (disk: DownloadDisk, name: string): Option.Option<DownloadRecord> =>
  Option.filter(
    Option.flatMap(
      Option.fromNullishOr(Result.getOrNull(disk.read(`${name}/${RECORD_FILE}`))),
      parseRecord,
    ),
    (download) => itemFolder(download.id) === name,
  );

/**
 * Reads the downloads index: the index itself, else the new copy a save left when a crash came
 * after it deleted the old index and before the copy took its place. When neither reads, every
 * download whose folder holds a readable copy of its row comes back from it.
 */
export const readIndex = (disk: DownloadDisk): IndexRead =>
  Option.match(
    Option.orElse(storeAt(disk, STORE_FILE), () => storeAt(disk, nextOf(STORE_FILE))),
    {
      onSome: (store) => IndexRead.Readable({ store }),
      onNone: () => {
        const names = disk.list();

        if (Result.isSuccess(names) && names.success.length === 0) return IndexRead.None();

        return IndexRead.Unreadable({
          recovered: {
            downloads: Result.getOrElse(names, () => []).flatMap((name) =>
              Option.toArray(recordIn(disk, name)),
            ),
            pendingProgress: EMPTY_STORE.pendingProgress,
          },
        });
      },
    },
  );

/**
 * Moves an index that could not be read aside, so the one rebuilt in its place never overwrites
 * it. Nothing there to move is fine.
 */
export const setAsideIndex = (disk: DownloadDisk): Result.Result<void, DiskFailed> =>
  disk.exists(STORE_FILE)
    ? disk.move(STORE_FILE, UNREADABLE_STORE_FILE)
    : Result.succeed(undefined);

/**
 * Saves `download`'s own copy of its row in its folder, from which `readIndex` rebuilds it when
 * the index cannot be read.
 */
export const keepRecord = (
  disk: DownloadDisk,
  download: DownloadRecord,
): Result.Result<void, DiskFailed> =>
  replaceFile(disk, itemPath(download.id, RECORD_FILE), serializeRecord(download));

/** Saves the copy of each download in `store` whose folder lacks it or holds an older one. */
export const keepRecords = (disk: DownloadDisk, store: DownloadStore): void => {
  for (const download of store.downloads) {
    const kept = Result.getOrNull(disk.read(itemPath(download.id, RECORD_FILE)));

    if (kept !== serializeRecord(download)) keepRecord(disk, download);
  }
};
