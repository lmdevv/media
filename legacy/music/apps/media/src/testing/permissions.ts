import { chmod } from "node:fs/promises";

/** Removes every permission from `path`. */
export const makeUnreadable = (path: string): Promise<void> => chmod(path, 0o000);

/** Restores owner read, write, and traverse permissions on `path`. */
export const makeReadable = (path: string): Promise<void> => chmod(path, 0o755);

/** Permission checks do not apply to root, so tests that need them skip there. */
export const runsAsRoot = (): boolean => process.getuid?.() === 0;
