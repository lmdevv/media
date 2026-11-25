import { Data, Option, Result } from "effect";

import { DiskFailed } from "./disk";
import type { DownloadDisk } from "./disk";
import {
  RECORD_FILE,
  STORE_FILE,
  UNREADABLE_STORE_FILE,
  itemFolder,
  itemPath,
  nextOf,
} from "./files";
import {
  EMPTY_STORE,
  IndexText,
  Standing,
  agreed,
  emptyFolder,
  parseIndex,
  parseRecord,
  serializeIndex,
  serializeRecord,
  unowned,
} from "./model";
import type {
  DownloadRecord,
  DownloadStore,
  KnownStore,
  ListedDownload,
  WholeStore,
} from "./model";

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

/** Saves the store as the downloads index, marked with its standing, replacing the one there whole. */
export const saveIndex = (disk: DownloadDisk, known: KnownStore): Result.Result<void, DiskFailed> =>
  replaceFile(disk, STORE_FILE, serializeIndex(known));

/** What reading one copy of the downloads index found. */
type IndexFile = Data.TaggedEnum<{
  Absent: {};
  /** The read failed, such as on an I/O error or a file iOS keeps locked. */
  Failed: { readonly cause: DiskFailed };
  Read: { readonly text: IndexText };
}>;

const IndexFile = Data.taggedEnum<IndexFile>();

const readIndexFile = (disk: DownloadDisk, path: string): IndexFile =>
  Result.match(disk.read(path), {
    onFailure: (cause) => IndexFile.Failed({ cause }),
    onSuccess: (text) =>
      text === null ? IndexFile.Absent() : IndexFile.Read({ text: parseIndex(text) }),
  });

/**
 * The download whose own copy of its row is in the folder `name`, when it reads as that one: its
 * `download.json`, else the new copy a replacement left when a crash came after it deleted the
 * old one. A copy that cannot be read is none, and its folder stays.
 */
const recordIn = (disk: DownloadDisk, name: string): Option.Option<DownloadRecord> => {
  const read = (path: string) =>
    Option.flatMap(Option.fromNullishOr(Result.getOrNull(disk.read(path))), parseRecord);

  const copy = Result.match(disk.read(itemPath(name, RECORD_FILE)), {
    onFailure: () => Option.none<DownloadRecord>(),
    onSuccess: (text) =>
      text === null ? read(itemPath(name, nextOf(RECORD_FILE))) : parseRecord(text),
  });

  return Option.filter(copy, (download) => itemFolder(download.id) === name);
};

/** What a launch found of the person's downloads. */
export type Launch = Data.TaggedEnum<{
  /**
   * The index, or the folder it decides by, could not be read: nothing is decided, deleted, or
   * saved until it can. `shown` holds the downloads rebuilt from their own copies, to play meanwhile.
   */
  Held: { readonly shown: DownloadStore; readonly cause: DiskFailed };
  /**
   * The downloads, and how far they speak for the folder. `misplaced` when the index at
   * `index.json` did not read whole and must move aside before a save replaces it; `fromCopies`
   * counts the downloads rebuilt from their own copies, which a save keeps.
   */
  Loaded: KnownStore & { readonly misplaced: boolean; readonly fromCopies: number };
}>;

/** Constructors and matchers for `Launch`. */
export const Launch = Data.taggedEnum<Launch>();

/** `store` with the download of every folder in `names` it does not own whose copy reads. */
const withCopies = (
  disk: DownloadDisk,
  store: DownloadStore,
  names: ReadonlyArray<string>,
): DownloadStore => ({
  downloads: [
    ...store.downloads,
    ...unowned(store, names).flatMap((name) => Option.toArray(recordIn(disk, name))),
  ],
  pendingProgress: store.pendingProgress,
});

const held = (disk: DownloadDisk, cause: DiskFailed): Launch =>
  Launch.Held({
    shown: withCopies(disk, EMPTY_STORE, Result.getOrNull(disk.list()) ?? []),
    cause,
  });

/** An `Unproven` launch of `store`, with the download of every folder in `names` it does not own whose copy reads. */
const unproven = (
  disk: DownloadDisk,
  store: DownloadStore,
  misplaced: boolean,
  names: ReadonlyArray<string>,
): Launch => {
  const merged = withCopies(disk, store, names);

  return Launch.Loaded({
    store: merged,
    standing: Standing.Unproven(),
    misplaced,
    fromCopies: merged.downloads.length - store.downloads.length,
  });
};

/**
 * The launch an index's text makes. Rebuilding one that is not an index needs the folder's
 * listing, so one that fails holds the launch. An index that read but not whole takes the
 * downloads of the folders it does not own from their copies; a listing that fails adds none, and
 * the next launch tries again.
 */
const fromText = (disk: DownloadDisk, text: IndexText, misplaced: boolean): Launch =>
  IndexText.$match(text, {
    NotAnIndex: () =>
      Result.match(disk.list(), {
        onFailure: (cause) => held(disk, cause),
        onSuccess: (names) => unproven(disk, EMPTY_STORE, misplaced, names ?? []),
      }),
    SomeRows: ({ store }) => unproven(disk, store, misplaced, Result.getOrNull(disk.list()) ?? []),
    AllRows: ({ store, standing }) =>
      Standing.$is("Whole")(standing)
        ? Launch.Loaded({ store, standing, misplaced: false, fromCopies: 0 })
        : unproven(disk, store, false, Result.getOrNull(disk.list()) ?? []),
  });

const contradiction = (path: string): DiskFailed =>
  new DiskFailed({
    operation: "read",
    path,
    cause: new Error("The folder lists the file, but reading it finds none."),
  });

/**
 * The launch when there is no `index.json`. The new copy a save left is the index only here,
 * after a crash came between the save deleting the old index and moving the copy in, and only
 * when the folder lists no `index.json`: a stale copy never outranks an index that is there. An
 * empty folder, or none, is a first run; one that cannot be listed is not.
 */
const withoutIndex = (disk: DownloadDisk): Launch =>
  Result.match(disk.list(), {
    onFailure: (cause) => held(disk, cause),
    onSuccess: (names) => {
      const standing = emptyFolder(names);

      if (Standing.$is("Whole")(standing)) {
        return Launch.Loaded({ store: EMPTY_STORE, standing, misplaced: false, fromCopies: 0 });
      }

      const listed = names ?? [];

      if (listed.includes(STORE_FILE)) return held(disk, contradiction(STORE_FILE));

      if (!listed.includes(nextOf(STORE_FILE))) return unproven(disk, EMPTY_STORE, false, listed);

      return IndexFile.$match(readIndexFile(disk, nextOf(STORE_FILE)), {
        Absent: () => held(disk, contradiction(nextOf(STORE_FILE))),
        Failed: ({ cause }) => held(disk, cause),
        Read: ({ text }) => fromText(disk, text, false),
      });
    },
  });

/**
 * Reads the person's downloads index. A read that fails decides nothing. An index that read but
 * not whole, or is missing beside downloads' folders, is `Unproven`, and the downloads it lacks
 * come back from their own copies.
 */
export const readIndex = (disk: DownloadDisk): Launch =>
  IndexFile.$match(readIndexFile(disk, STORE_FILE), {
    Absent: () => withoutIndex(disk),
    Failed: ({ cause }) => held(disk, cause),
    Read: ({ text }) => fromText(disk, text, true),
  });

/**
 * Moves an index that did not read whole aside, so the one saved in its place never overwrites
 * it.
 */
export const setAsideIndex = (disk: DownloadDisk): Result.Result<void, DiskFailed> =>
  disk.move(STORE_FILE, UNREADABLE_STORE_FILE);

/**
 * Deletes what no download in a `Whole` store owns from the person's folder: the folders of
 * downloads the person or the engine removed, and stray files. The index and its copies stay.
 * Running it again deletes nothing more; a delete that fails is tried again the next time, and a
 * listing that fails deletes nothing.
 */
export const sweep = (disk: DownloadDisk, { store }: WholeStore): void => {
  for (const name of unowned(store, Result.getOrNull(disk.list()) ?? [])) disk.remove(name);
};

/** `known`'s standing after the core's whole list, `listed`; see `agreed`. */
export const agree = (
  disk: DownloadDisk,
  known: KnownStore,
  listed: ReadonlyArray<ListedDownload>,
): Standing =>
  Result.match(disk.list(), {
    onFailure: () => known.standing,
    onSuccess: (names) => agreed(known, names, listed),
  });

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
