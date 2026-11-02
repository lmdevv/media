import { utimes } from "node:fs/promises";

/** Sets the access and modification times of `path` to `ms` milliseconds since the epoch. */
export const setFileTime = (path: string, ms: number): Promise<void> =>
  utimes(path, ms / 1000, ms / 1000);
