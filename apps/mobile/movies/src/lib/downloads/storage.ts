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
  removalNamed,
  videoFile,
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
 * download, and the engine retries them until then. While it lasts it outranks everything of the
 * download that is older than it: a row in any index, a copy of the row, and a folder made again
 * under the download's name. Only this module makes one, from that folder.
 */
export interface Removal {
  /** The file the core is told to forget. */
  readonly id: FileId;
  /**
   * When it was recorded, on the engine's clock. A download of the same file added after it is a
   * new one, which the removal leaves alone.
   */
  readonly stamp: number;
  /** The removal's folder in the person's folder, which holds what is left of the files. */
  readonly folder: string;
  readonly recorded: typeof recorded;
}

const removalAt = (folder: string): Option.Option<Removal> =>
  Option.flatMap(Option.fromNullishOr(removalNamed(folder)), ({ id, stamp }) =>
    Option.map(fileIdOf(id), (file): Removal => ({ id: file, stamp, folder, recorded })),
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

  return Result.map(made, (): Removal => ({ id, stamp, folder, recorded }));
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
   * saved until it can. `shown` holds what could be read and proven, the index's rows or the
   * downloads rebuilt from their own copies, to play meanwhile.
   */
  Held: { readonly shown: DownloadStore; readonly cause: DiskFailed };
  /**
   * The downloads, and the removals still to carry out. `leftovers` are folders made again under a
   * removed download's name after its removal, such as by a transfer that landed late, which go
   * with the removal. `misplaced` when the index at `index.json` did not read whole and must move
   * aside before a save replaces it; `changed` when the store differs from the index, which a save
   * then catches up.
   */
  Loaded: {
    readonly store: DownloadStore;
    readonly removals: ReadonlyArray<Removal>;
    readonly leftovers: ReadonlyArray<string>;
    readonly misplaced: boolean;
    readonly changed: boolean;
  };
}>;

/** Constructors and matchers for `Launch`. */
export const Launch = Data.taggedEnum<Launch>();

/** What a launch knows of the download of one file. */
interface Holding {
  /** Its row in the index. */
  readonly row: DownloadRecord | undefined;
  /** The latest removal of it recorded. */
  readonly removal: Removal | undefined;
  /** Whether its folder is there, by the listing or, when the listing lacks it, a direct check. */
  readonly housed: boolean;
  /** The download its folder's own copy holds, read only when the row does not settle it. */
  readonly copy: () => Option.Option<DownloadRecord>;
}

/** What a launch makes of the download of one file. */
type Verdict = Data.TaggedEnum<{
  Kept: { readonly download: DownloadRecord };
  /**
   * No download. Its row, if any, goes. `leftover` when its folder was made again after a recorded
   * removal, and goes with it.
   */
  None: { readonly leftover: boolean };
}>;

const Verdict = Data.taggedEnum<Verdict>();

/**
 * `download` by whether its folder is there. Without one, a download that had one, or that says
 * it is ready to play, holds nothing. Only a removal moves a folder away, and there is nothing to
 * play. One never given a folder, such as one still queued, stays.
 */
const housing = (download: DownloadRecord, housed: boolean): Verdict => {
  if (housed) {
    return Verdict.Kept({
      download: download.hasFolder ? download : Struct.assign(download, { hasFolder: true }),
    });
  }

  return download.hasFolder || download.phase === "ready"
    ? Verdict.None({ leftover: false })
    : Verdict.Kept({ download });
};

/**
 * What a launch makes of the download of one file, always in this order. A recorded removal comes
 * first. Only a download added after it, by its row or its folder's own copy, is kept, and a
 * folder under the file's name holding none goes with the removal. Then the row, else the folder's
 * copy, by whether the folder is there.
 */
const judge = ({ row, removal, housed, copy }: Holding): Verdict => {
  const current = (download: DownloadRecord): boolean =>
    removal === undefined || download.addedAt > removal.stamp;

  const download =
    row !== undefined && current(row)
      ? Option.some(row)
      : housed
        ? Option.filter(copy(), current)
        : Option.none();

  return Option.match(download, {
    onNone: () => Verdict.None({ leftover: removal !== undefined && housed }),
    onSome: (kept) => housing(kept, housed),
  });
};

/** The latest removal of each file among `removals`. */
const latestOf = (removals: ReadonlyArray<Removal>): ReadonlyMap<FileId, Removal> =>
  removals.reduce((latest, removal) => {
    const known = latest.get(removal.id);

    return known === undefined || known.stamp < removal.stamp
      ? new Map(latest).set(removal.id, removal)
      : latest;
  }, new Map<FileId, Removal>());

/** What a launch makes of the index's rows beside the person's folder. */
interface Judged {
  readonly downloads: ReadonlyArray<DownloadRecord>;
  /** Folders made again under a removed download's name after its removal, which go with it. */
  readonly leftovers: ReadonlyArray<string>;
}

/**
 * Judges every file the launch knows of: each row of `indexed`, each file with a removal among
 * `removals`, and each folder in `names` whose own copy reads, in that order. A folder whose copy
 * does not read, and that no row or removal speaks for, is no download, and stays as it is.
 */
const judged = (
  disk: DownloadDisk,
  indexed: DownloadStore,
  names: ReadonlyArray<string>,
  removals: ReadonlyArray<Removal>,
): Judged => {
  const present = new Set(names);
  const latest = latestOf(removals);

  const housed = (id: string): boolean =>
    present.has(itemFolder(id)) || disk.exists(itemFolder(id));

  const verdictOf = (id: FileId, row: DownloadRecord | undefined) => ({
    id,
    verdict: judge({
      row,
      removal: latest.get(id),
      housed: housed(id),
      copy: () => recordIn(disk, itemFolder(id)),
    }),
  });

  const rowIds = new Set(indexed.downloads.map((download) => download.id));
  const claimed = new Set([...rowIds, ...latest.keys()].map(itemFolder));

  const copies = unowned(indexed, names)
    .filter((name) => !claimed.has(name) && removalNamed(name) === null)
    .flatMap((name) => Option.toArray(recordIn(disk, name)));

  const verdicts = [
    ...indexed.downloads.map((row) => verdictOf(row.id, row)),
    ...[...latest.keys()].flatMap((id) => (rowIds.has(id) ? [] : [verdictOf(id, undefined)])),
    ...copies.map((copy) => ({
      id: copy.id,
      verdict: judge({
        row: undefined,
        removal: latest.get(copy.id),
        housed: true,
        copy: () => Option.some(copy),
      }),
    })),
  ];

  return {
    downloads: verdicts.flatMap(({ verdict }) =>
      Verdict.$is("Kept")(verdict) ? [verdict.download] : [],
    ),
    leftovers: verdicts.flatMap(({ id, verdict }) =>
      Verdict.$is("None")(verdict) && verdict.leftover ? [itemFolder(id)] : [],
    ),
  };
};

/**
 * Whether a held launch, which cannot judge, shows `download`. It shows one ready to play only while
 * its video is there, and one that had a folder only while that folder is there.
 */
const provable = (disk: DownloadDisk, download: DownloadRecord): boolean =>
  download.phase === "ready"
    ? download.delivery !== null &&
      disk.exists(itemPath(download.id, videoFile(download.delivery.container)))
    : !download.hasFolder || disk.exists(itemFolder(download.id));

const held = (
  disk: DownloadDisk,
  store: DownloadStore,
  listing: Result.Result<ReadonlyArray<string> | null, DiskFailed>,
  cause: DiskFailed,
): Launch => {
  const readable = Result.match(listing, {
    onFailure: () => store.downloads,
    onSuccess: (names) => judged(disk, store, names ?? [], removalsIn(names ?? [])).downloads,
  });

  return Launch.Held({
    shown: {
      downloads: readable.filter((download) => provable(disk, download)),
      pendingProgress: store.pendingProgress,
    },
    cause,
  });
};

/** The launch of the downloads in `indexed` beside the folder's `names`, judged one file at a time. */
const loaded = (
  disk: DownloadDisk,
  indexed: DownloadStore,
  misplaced: boolean,
  names: ReadonlyArray<string>,
): Launch => {
  const removals = removalsIn(names);
  const { downloads, leftovers } = judged(disk, indexed, names, removals);

  return Launch.Loaded({
    store: { downloads, pendingProgress: indexed.pendingProgress },
    removals,
    leftovers,
    misplaced,
    changed:
      downloads.length !== indexed.downloads.length ||
      downloads.some((download, index) => download !== indexed.downloads[index]),
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
