import { Directory, DownloadTask, File, Paths } from "expo-file-system";

import { byteCount, onDisk } from "@/lib/downloads/disk";
import type { DownloadDisk } from "@/lib/downloads/disk";

/** The phone's free space in bytes. */
export const freeSpace = (): number => byteCount(Paths.availableDiskSpace);

/** The person's downloads folder `folder`, through expo-file-system. */
export const expoDisk = (folder: Directory): DownloadDisk => {
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
