/**
 * Folder identities that survive every way of naming a folder. A path, even resolved through
 * links, can still differ for the same folder: a bind mount shows one folder at two paths, and
 * resolving paths does not see through it. The media service reports two identities for a
 * library's folder, and Convex compares both:
 *
 * - its device and inode (`<dev>:<ino>`) and every folder's above it, up to `/` (a `FolderChain`),
 *   the same under any name. They catch one folder mounted twice, but not a library's subfolder
 *   bound elsewhere: walking up from the bound path never passes the library's folder.
 * - its file system path (`<major>:<minor>:/path/in/fs`), from the mount table: which file system
 *   the folder is on and where in it, wherever it is mounted. Comparing those paths catches a
 *   subfolder however it is bound.
 */

/**
 * A folder's identity and its parents' up to `/`, the folder itself first. Built by the media
 * service from `stat`; each entry is `<device>:<inode>`.
 */
export type FolderChain = ReadonlyArray<string>;

/**
 * Whether two folders are the same, or one sits inside the other, whatever paths they were
 * reached by: one folder's own identity appears in the other's chain.
 */
export const chainsOverlap = (left: FolderChain, right: FolderChain): boolean => {
  const [leftRoot] = left;
  const [rightRoot] = right;

  return (
    (leftRoot !== undefined && right.includes(leftRoot)) ||
    (rightRoot !== undefined && left.includes(rightRoot))
  );
};

/** A file system path's file system and its path there; null when it isn't one. */
const splitFsPath = (fsPath: string): { readonly device: string; readonly path: string } | null => {
  const at = fsPath.indexOf(":/");

  return at === -1 ? null : { device: fsPath.slice(0, at), path: fsPath.slice(at + 1) };
};

const inside = (inner: string, outer: string): boolean =>
  inner === outer || outer === "/" || inner.startsWith(`${outer}/`);

/**
 * Whether two file system paths (`<major>:<minor>:/path`) are the same folder, or one is inside
 * the other: on the same file system, one path holds the other. Segment-aware, so `/a` and
 * `/ab` are apart.
 */
export const fsPathsOverlap = (left: string, right: string): boolean => {
  const a = splitFsPath(left);
  const b = splitFsPath(right);

  if (a === null || b === null || a.device !== b.device) return false;

  return inside(a.path, b.path) || inside(b.path, a.path);
};
