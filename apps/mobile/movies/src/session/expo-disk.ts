import { Directory, DownloadTask, File, Paths } from "expo-file-system";

import { byteCount, onDisk } from "@/lib/downloads/disk";
import type { DownloadDisk } from "@/lib/downloads/disk";

/** The phone's free space in bytes. */
export const freeSpace = (): number => byteCount(Paths.availableDiskSpace);

/**
 * Null for the folder at `names` under `root`, which reads as absent, once a folder above it lists
 * without it: iOS also answers that a folder does not exist when it cannot tell. Throws when a
 * folder above cannot be listed, or every one lists the next.
 */
const absent = (root: Directory, names: ReadonlyArray<string>): null => {
  const [name, ...below] = names;

  if (name === undefined) throw new Error("The downloads folder is listed, but reads as absent.");

  return root.list().some((entry) => entry.name === name)
    ? absent(new Directory(root, name), below)
    : null;
};

/** The person's downloads folder at `folderPath` under the documents folder `root`. */
export const expoDisk = (root: Directory, folderPath: string): DownloadDisk => {
  const folder = new Directory(root, ...folderPath.split("/"));
  const fileAt = (path: string): File => new File(folder, ...path.split("/"));
  const directoryAt = (path: string): Directory => new Directory(folder, ...path.split("/"));

  return {
    read: (path) =>
      onDisk("read", path, () => {
        const file = fileAt(path);

        return file.exists ? file.textSync() : null;
      }),
    write: (path, text) =>
      onDisk("write", path, () => {
        const file = fileAt(path);

        file.parentDirectory.create({ intermediates: true, idempotent: true });
        file.writeSync(text);
      }),
    move: (from, to) =>
      onDisk("move", to, () => fileAt(from).moveSync(fileAt(to), { overwrite: true })),
    remove: (path) =>
      onDisk("remove", path, () => {
        const file = fileAt(path);
        const directory = directoryAt(path);

        if (directory.exists) directory.delete();
        else if (file.exists) file.delete();
      }),
    list: () =>
      onDisk("list", "", () =>
        folder.exists
          ? folder.list().map((entry) => entry.name)
          : absent(root, folderPath.split("/")),
      ),
    createFolder: (path) =>
      onDisk("createFolder", path, () =>
        directoryAt(path).create({ intermediates: true, idempotent: true }),
      ),
    exists: (path) => fileAt(path).exists || directoryAt(path).exists,
    uri: (path) => fileAt(path).uri,
    fetch: (url, path) =>
      File.downloadFileAsync(url, fileAt(path), { idempotent: true }).then(
        () => true,
        () => false,
      ),
    transfer: (url, path, onProgress) => File.createDownloadTask(url, fileAt(path), { onProgress }),
    resume: (state, onProgress) => {
      try {
        return DownloadTask.fromSavable(state, { onProgress });
      } catch {
        return null;
      }
    },
    freeBytes: freeSpace,
  };
};
