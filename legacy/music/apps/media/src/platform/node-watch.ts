/**
 * Recursive directory watching with `fs.watch`. Effect's `FileSystem.watch` is marked unstable in
 * Effect 4.0.2 and the lint policy rejects both unstable Effect APIs and `node:fs` inside Effect
 * modules, so this Effect-free leaf owns the watcher. `library-watcher.ts` adapts it to a stream.
 */
import { statSync, watch } from "node:fs";

/**
 * The reason `path` is no longer a watchable folder (gone, replaced, or unreadable), or null
 * while it is one.
 */
const folderGone = (path: string): Error | null => {
  try {
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) return null;
  } catch (error) {
    // Unreadable now, such as a share that went away under the mount point (`EACCES`, `EIO`).
    return error instanceof Error ? error : new Error(String(error));
  }

  return Object.assign(new Error(`ENOENT: the watched folder is gone, watch '${path}'`), {
    code: "ENOENT",
  });
};

/**
 * Watches `root` recursively and calls `onChange` with each changed path relative to the root
 * (or `null` when the platform does not report one). `onError` receives watcher failures, after
 * which no more changes arrive, including the root folder going away (deleted, or a drive
 * unmounted). Returns a function that stops watching. Throws when the watcher cannot start, for
 * example when the folder is missing or a system limit on watches is reached (`ENOSPC`).
 */
export const watchTree = (
  root: string,
  onChange: (relativePath: string | null) => void,
  onError: (error: Error) => void,
): (() => void) => {
  // On Linux a recursive `fs.watch` starts on a missing folder without an error, then reports
  // nothing ever, even once the folder exists.
  if (!statSync(root).isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: not a directory, watch '${root}'`), {
      code: "ENOTDIR",
    });
  }

  const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
    // An event without a name is about the root itself. A root that went away takes the watch
    // with it: the watch reports nothing more, even once the folder is back.
    const gone = filename === null || filename === "" ? folderGone(root) : null;

    if (gone !== null) {
      onError(gone);

      return;
    }

    onChange(filename === "" ? null : filename);
  });

  watcher.on("error", onError);

  return () => {
    watcher.close();
  };
};
