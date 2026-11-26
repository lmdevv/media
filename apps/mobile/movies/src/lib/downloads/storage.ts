import { Data, Option, Result, Struct } from "effect";

import { DiskFailed } from "./disk";
import type { DownloadDisk } from "./disk";
import {
  RECORD_FILE,
  STORE_FILE,
  UNREADABLE_STORE_FILE,
  itemFolder,
  itemPath,
  nextOf,
  removalFolder,
  removedIdOf,
} from "./files";
import {
  EMPTY_STORE,
  IndexText,
  fileIdOf,
  parseIndex,
  parseRecord,
  serializeRecord,
  serializeStore,
  unowned,
} from "./model";
import type { DownloadRecord, DownloadStore, EmptyRecord, FileId, Holdings } from "./model";

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

/** Saves the store as the downloads index, replacing the one there whole. */
export const saveIndex = (
  disk: DownloadDisk,
  store: DownloadStore,
): Result.Result<void, DiskFailed> => replaceFile(disk, STORE_FILE, serializeStore(store));

const recorded = Symbol("recorded");

/**
 * A download the person removed, or the engine removed following the core, recorded on this
 * iPhone before anything of it is deleted. The record is the removal's folder: the download's own
 * folder renamed in one step, or a new empty folder when the download had none. It lasts until
 * both halves are done, the files gone and the core acknowledging it no longer counts the
 * download, and every launch, sync, and reconnection retries them until then. Only this module
 * makes one, from that folder.
 */
export interface Removal {
  /** The file the core is told to forget. */
  readonly id: FileId;
  /** The removal's folder in the person's folder, which holds what is left of the files. */
  readonly folder: string;
  readonly recorded: typeof recorded;
}

const removalAt = (folder: string): Option.Option<Removal> =>
  Option.map(
    Option.flatMap(Option.fromNullishOr(removedIdOf(folder)), fileIdOf),
    (id): Removal => ({ id, folder, recorded }),
  );

/** The removals recorded in the person's folder, whose names are `names`. */
const removalsIn = (names: ReadonlyArray<string>): ReadonlyArray<Removal> =>
  names.flatMap((name) => Option.toArray(removalAt(name)));

/**
 * Records the removal of download `id` at `stamp`: renames its folder to the removal's folder, or,
 * when a listing shows it has none, makes that folder. A rename needs no free space, so a full disk
 * still records one. A download whose removal cannot be recorded is not removed.
 */
export const recordRemoval = (
  disk: DownloadDisk,
  id: FileId,
  stamp: number,
): Result.Result<Removal, DiskFailed> => {
  const folder = removalFolder(id, stamp);
  const renamed = disk.rename(itemFolder(id), folder);

  const made = Result.isSuccess(renamed)
    ? renamed
    : Result.flatMap(disk.list(), (names) =>
        names?.includes(itemFolder(id)) === true ? renamed : disk.createFolder(folder),
      );

  return Result.map(made, (): Removal => ({ id, folder, recorded }));
};

/**
 * Deletes the files a removal holds, keeping its folder, which stays the record of it until the
 * core acknowledges it. A delete that fails is tried again the next time.
 */
export const clearRemoval = (disk: DownloadDisk, removal: Removal): void => {
  for (const name of Result.getOrNull(disk.list(removal.folder)) ?? []) {
    disk.remove(`${removal.folder}/${name}`);
  }
};

/** Deletes a removal's folder and what is left in it, once the core acknowledged the removal. */
export const endRemoval = (disk: DownloadDisk, removal: Removal): Result.Result<void, DiskFailed> =>
  disk.remove(removal.folder);

/**
 * Deletes the files in a download's folder except its own copy of its row, for a download whose
 * row already says it holds no copy of its file, such as one the core says has expired.
 */
export const clearMedia = (disk: DownloadDisk, download: EmptyRecord): void => {
  const folder = itemFolder(download.id);
  const kept = new Set([RECORD_FILE, nextOf(RECORD_FILE)]);

  for (const name of Result.getOrNull(disk.list(folder)) ?? []) {
    if (!kept.has(name)) disk.remove(`${folder}/${name}`);
  }
};

/**
 * Whether this iPhone holds a download's folder, found in a listing of the person's folder or
 * where the folder would be, or a removal of it; null when the folder cannot be listed.
 */
export const holdingsOf = (disk: DownloadDisk): Holdings =>
  Result.match(disk.list(), {
    onFailure: () => null,
    onSuccess: (listed) => {
      const names = new Set(listed ?? []);
      const removed = new Set(removalsIn(listed ?? []).map((removal) => removal.id));

      return (id) => names.has(itemFolder(id)) || removed.has(id) || disk.exists(itemFolder(id));
    },
  });

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
   * The index, or the folder that holds it, could not be read: nothing is decided, deleted, or
   * saved until it can. `shown` holds what could be read, the index's rows or the downloads
   * rebuilt from their own copies, to play meanwhile.
   */
  Held: { readonly shown: DownloadStore; readonly cause: DiskFailed };
  /**
   * The downloads, and the removals still to carry out. `misplaced` when the index at
   * `index.json` did not read whole and must move aside before a save replaces it; `changed` when
   * the store differs from the index, which a save then catches up.
   */
  Loaded: {
    readonly store: DownloadStore;
    readonly removals: ReadonlyArray<Removal>;
    readonly misplaced: boolean;
    readonly changed: boolean;
  };
}>;

/** Constructors and matchers for `Launch`. */
export const Launch = Data.taggedEnum<Launch>();

/**
 * The downloads of the folders in `names` that `store` lacks, from their own copies. A removal's
 * folder is never one: a removal moves the folder away from the download's name.
 */
const copiesIn = (
  disk: DownloadDisk,
  store: DownloadStore,
  names: ReadonlyArray<string>,
): ReadonlyArray<DownloadRecord> =>
  unowned(store, names).flatMap((name) =>
    removedIdOf(name) === null ? Option.toArray(recordIn(disk, name)) : [],
  );

const withCopies = (
  disk: DownloadDisk,
  store: DownloadStore,
  names: ReadonlyArray<string>,
): DownloadStore => ({
  downloads: [...store.downloads, ...copiesIn(disk, store, names)],
  pendingProgress: store.pendingProgress,
});

const held = (
  disk: DownloadDisk,
  store: DownloadStore,
  listing: Result.Result<ReadonlyArray<string> | null, DiskFailed>,
  cause: DiskFailed,
): Launch =>
  Launch.Held({
    shown: Result.match(listing, {
      onFailure: () => store,
      onSuccess: (names) => withCopies(disk, store, names ?? []),
    }),
    cause,
  });

/**
 * The launch of the downloads in `indexed` beside the folder's `names`. A folder whose own copy of
 * its row reads is a kept download, and the store takes it when the index lacks it. An index row
 * whose folder is missing is dropped when its folder was made or a removal of it is recorded,
 * since only a removal moves a download's folder away; one never given a folder, from main or
 * still queued, stays.
 */
const loaded = (
  disk: DownloadDisk,
  indexed: DownloadStore,
  misplaced: boolean,
  names: ReadonlyArray<string>,
): Launch => {
  const present = new Set(names);
  const removals = removalsIn(names);
  const removed = new Set(removals.map((removal) => removal.id));
  const housed = (download: DownloadRecord): boolean => present.has(itemFolder(download.id));

  const rows = indexed.downloads.flatMap((download): ReadonlyArray<DownloadRecord> => {
    if (housed(download)) return [Struct.assign(download, { hasFolder: true })];

    return download.hasFolder || removed.has(download.id) ? [] : [download];
  });

  const kept: DownloadStore = { downloads: rows, pendingProgress: indexed.pendingProgress };
  const copies = copiesIn(disk, kept, names);

  return Launch.Loaded({
    store: { downloads: [...rows, ...copies], pendingProgress: kept.pendingProgress },
    removals,
    misplaced,
    changed:
      rows.length < indexed.downloads.length ||
      copies.length > 0 ||
      indexed.downloads.some((download) => housed(download) && !download.hasFolder),
  });
};

/** The launch an index's text makes, `atIndex` when it was read at `index.json`. */
const fromText = (
  disk: DownloadDisk,
  text: IndexText,
  atIndex: boolean,
  names: ReadonlyArray<string>,
): Launch =>
  IndexText.$match(text, {
    NotAnIndex: () => loaded(disk, EMPTY_STORE, atIndex, names),
    SomeRows: ({ store }) => loaded(disk, store, atIndex, names),
    AllRows: ({ store }) => loaded(disk, store, false, names),
  });

const contradiction = (path: string): DiskFailed =>
  new DiskFailed({
    operation: "read",
    path,
    cause: new Error("The folder lists the file, but reading it finds none."),
  });

/**
 * The launch when there is no `index.json`, beside the folder's `names`. The new copy a save left
 * is the index only here, after a crash came between the save deleting the old index and moving
 * the copy in, and only when the folder lists no `index.json`: a stale copy never outranks an index
 * that is there. Otherwise the downloads come from their own copies.
 */
const withoutIndex = (disk: DownloadDisk, names: ReadonlyArray<string>): Launch => {
  const listing = Result.succeed(names);

  if (names.includes(STORE_FILE))
    return held(disk, EMPTY_STORE, listing, contradiction(STORE_FILE));

  if (!names.includes(nextOf(STORE_FILE))) return loaded(disk, EMPTY_STORE, false, names);

  return IndexFile.$match(readIndexFile(disk, nextOf(STORE_FILE)), {
    Absent: () => held(disk, EMPTY_STORE, listing, contradiction(nextOf(STORE_FILE))),
    Failed: ({ cause }) => held(disk, EMPTY_STORE, listing, cause),
    Read: ({ text }) => fromText(disk, text, false, names),
  });
};

const rowsOf = (text: IndexText): DownloadStore =>
  IndexText.$match(text, {
    NotAnIndex: () => EMPTY_STORE,
    SomeRows: ({ store }) => store,
    AllRows: ({ store }) => store,
  });

/**
 * Reads the person's downloads: the index, and a listing of their folder. A read or a listing that
 * fails decides nothing and holds the launch. The downloads the index lacks come back from their
 * own copies, and the rows of downloads whose removal moved their folder away are dropped.
 */
export const readIndex = (disk: DownloadDisk): Launch => {
  const file = readIndexFile(disk, STORE_FILE);
  const listing = disk.list();

  return IndexFile.$match(file, {
    Failed: ({ cause }) => held(disk, EMPTY_STORE, listing, cause),
    Absent: () =>
      Result.match(listing, {
        onFailure: (cause) => held(disk, EMPTY_STORE, listing, cause),
        onSuccess: (names) => withoutIndex(disk, names ?? []),
      }),
    Read: ({ text }) =>
      Result.match(listing, {
        onFailure: (cause) => held(disk, rowsOf(text), listing, cause),
        onSuccess: (names) => fromText(disk, text, true, names ?? []),
      }),
  });
};

/**
 * Moves an index that did not read whole aside, so the one saved in its place never overwrites
 * it.
 */
export const setAsideIndex = (disk: DownloadDisk): Result.Result<void, DiskFailed> =>
  disk.move(STORE_FILE, UNREADABLE_STORE_FILE);

/**
 * Saves `download`'s own copy of its row in its folder, making the folder when it has none. The
 * copy keeps the download when the index loses it.
 */
export const keepRecord = (
  disk: DownloadDisk,
  download: DownloadRecord,
): Result.Result<void, DiskFailed> =>
  replaceFile(disk, itemPath(download.id, RECORD_FILE), serializeRecord(download));

/**
 * Saves the copy of each of `downloads` whose folder lacks it or holds an older one, and answers
 * the downloads whose folder now holds their current copy.
 */
export const keepRecords = (
  disk: DownloadDisk,
  downloads: ReadonlyArray<DownloadRecord>,
): ReadonlyArray<DownloadRecord> =>
  downloads.filter(
    (download) =>
      Result.getOrNull(disk.read(itemPath(download.id, RECORD_FILE))) ===
        serializeRecord(download) || Result.isSuccess(keepRecord(disk, download)),
  );
