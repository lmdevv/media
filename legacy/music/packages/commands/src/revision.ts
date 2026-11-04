/**
 * The version of a library file's bytes: its size and modification time in base 36. New bytes give
 * a new revision. The media service's `ETag` for an original is this value in quotes, so a client
 * that stored the revision can resume an original with `If-Range: "<revision>"`.
 */
export const fileRevision = (size: number, mtimeMs: number): string =>
  `${size.toString(36)}-${Math.trunc(mtimeMs).toString(36)}`;
