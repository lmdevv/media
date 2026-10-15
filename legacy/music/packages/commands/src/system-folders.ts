/**
 * Folders no library may be, one rule for Convex (`libraries.create`, `media:claimRoot`) and the
 * media service (before it claims a folder), so they never disagree.
 */

/**
 * Kernel file systems: `/proc/self/root/...` is the whole file system again under another name,
 * and `/sys` and `/dev` hold no music.
 */
const SYSTEM_ROOTS = ["/proc", "/sys", "/dev"] as const;

/** Why a system folder was refused; names no other folder. */
export const SYSTEM_FOLDER_MESSAGE = "A library folder can't be /, or be in /proc, /sys, or /dev";

/**
 * Whether a library may not be at `path` (absolute, normalised, no trailing slash): `/`, which
 * holds the kernel file systems, or a folder in one of them.
 */
export const isSystemFolder = (path: string): boolean =>
  path === "/" || SYSTEM_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
