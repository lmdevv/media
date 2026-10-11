/**
 * Recursive directory watching with `fs.watch`. Effect's `FileSystem.watch` is marked unstable in
 * Effect 4.0.2 and the lint policy rejects both unstable Effect APIs and `node:fs` inside Effect
 * modules, so this Effect-free leaf owns the watcher. `library-watcher.ts` adapts it to a stream.
 */
import { watch } from "node:fs";

/**
 * Watches `root` recursively and calls `onChange` with each changed path relative to the root
 * (or `null` when the platform does not report one). `onError` receives watcher failures, after
 * which no more changes arrive. Returns a function that stops watching. Throws when the watcher
 * cannot start, for example when the folder is missing.
 */
export const watchTree = (
  root: string,
  onChange: (relativePath: string | null) => void,
  onError: (error: Error) => void,
): (() => void) => {
  const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
    onChange(filename);
  });

  watcher.on("error", onError);

  return () => {
    watcher.close();
  };
};
