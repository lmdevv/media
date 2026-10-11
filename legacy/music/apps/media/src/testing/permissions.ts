/**
 * Test helpers that change folder permissions, kept free of Effect so they can use `node:fs`
 * directly. Tests use them to make part of a library unreadable to the scanner.
 */
import { chmod } from "node:fs/promises";

/** Removes every permission from `path`. */
export const makeUnreadable = (path: string): Promise<void> => chmod(path, 0o000);

/** Restores owner read, write, and traverse permissions on `path`. */
export const makeReadable = (path: string): Promise<void> => chmod(path, 0o755);

/** Permission checks do not apply to root, so tests that need them skip there. */
export const runsAsRoot = (): boolean => process.getuid?.() === 0;
