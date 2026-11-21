/**
 * Change detection for folders that send no file events: NFS, SMB/CIFS, 9p, and FUSE mounts such
 * as sshfs report changes made on the server or another client to nobody. A snapshot holds each
 * folder's modification time and subfolders; a folder's time changes when an entry is added,
 * removed, or renamed in it. Polling costs one `stat` per folder, and reads a folder again only
 * when its time moved. A file rewritten in place keeps its folder's time; the periodic
 * reconciliation scan catches that.
 */
import { Data, Effect, FileSystem, Option, Path } from "effect";

import { listEntries } from "../platform/node-directories.ts";
import { modifiedAtMs } from "../platform/file-info.ts";

interface FolderState {
  readonly modifiedAt: number;
  readonly folders: ReadonlyArray<string>;
}

class FolderUnlistable extends Data.TaggedError("FolderUnlistable")<{
  readonly cause: unknown;
}> {}

/** Every folder under a root, by absolute path. */
export type Snapshot = ReadonlyMap<string, FolderState>;

/** Magic numbers (`statfs` `f_type`) of file systems that do not report remote changes. */
const NETWORK_FILE_SYSTEMS: ReadonlySet<number> = new Set([
  0x6969, // NFS
  0x517b, // SMB
  0xfe534d42, // SMB2
  0xff534d42, // CIFS
  0x01021997, // 9p (WSL and VM shares)
  0x65735546, // FUSE: sshfs, rclone, mergerfs, and other user-space mounts
  0x6a656a63, // virtiofs
  0x00c36400, // Ceph
  0x5346414f, // AFS
  0x564c, // NCP
  0x73757245, // Coda
  0x47504653, // GPFS
  0x0bd00bd0, // Lustre
]);

/** Whether a file system with this `statfs` type should be polled rather than watched. */
export const isNetworkFileSystem = (type: number): boolean => NETWORK_FILE_SYSTEMS.has(type);

/**
 * Takes a snapshot of `root`, reusing `previous` for every folder whose modification time did not
 * change. Returns the snapshot and whether anything differs from `previous`. A folder that cannot
 * be read (an unmounted share) is left out, which counts as a change once it comes back.
 */
export const snapshot = Effect.fn("LibraryPoller.snapshot")(function* (
  root: string,
  previous: Snapshot,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const next = new Map<string, FolderState>();
  let changed = false;
  const pending = [root];

  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    const info = yield* fs.stat(folder).pipe(Effect.option);

    if (Option.isNone(info) || info.value.type !== "Directory") continue;
    const time = modifiedAtMs(info.value);
    const known = previous.get(folder);

    const state: FolderState =
      known !== undefined && known.modifiedAt === time
        ? known
        : {
            modifiedAt: time,
            folders: (yield* Effect.tryPromise({
              try: () => listEntries(folder),
              catch: (cause) => new FolderUnlistable({ cause }),
            }).pipe(Effect.orElseSucceed(() => [])))
              .filter((entry) => entry.kind === "directory" && !entry.name.startsWith("."))
              .map((entry) => path.join(folder, entry.name)),
          };

    if (state !== known) changed = true;
    next.set(folder, state);
    pending.push(...state.folders);
  }

  if (!changed && next.size !== previous.size) changed = true;

  return { snapshot: next satisfies Snapshot, changed };
});
