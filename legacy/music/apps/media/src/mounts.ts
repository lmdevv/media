/**
 * Where a folder really is on its file system, whatever mount shows it. A bind mount shows a
 * folder of one file system at another path; `/proc/self/mountinfo` says, for every mount, which
 * file system (`major:minor`) it shows and which folder of it (its root). A path's file system
 * path is that root joined with the rest of the path below the mount point, so two libraries on
 * one file system compare by those paths, which no bind mount can disguise
 * (`@music/commands/folder-ids`, `fsPathsOverlap`).
 */

/** One mount: the file system it shows, the folder of it, and where it is mounted. */
export interface Mount {
  readonly device: string;
  readonly root: string;
  readonly mountPoint: string;
}

/** Undoes mountinfo's octal escapes (`\040` for a space, `\134` for a backslash). */
const unescapeField = (field: string): string =>
  field.replaceAll(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );

/**
 * The mounts in `/proc/self/mountinfo` text, in order. Each line reads `id parent major:minor
 * root mount-point options ...`; malformed lines are skipped.
 */
export const parseMountinfo = (text: string): ReadonlyArray<Mount> =>
  text.split("\n").flatMap((line) => {
    const [, , device, root, mountPoint] = line.split(" ");

    if (device === undefined || root === undefined || mountPoint === undefined) return [];

    if (!/^\d+:\d+$/.test(device) || !root.startsWith("/") || !mountPoint.startsWith("/")) {
      return [];
    }

    return [{ device, root: unescapeField(root), mountPoint: unescapeField(mountPoint) }];
  });

const under = (mountPoint: string, path: string): boolean =>
  mountPoint === "/" || path === mountPoint || path.startsWith(`${mountPoint}/`);

/**
 * The file system path of an absolute, resolved `path` (`major:minor:/folder/in/fs`), or null
 * when no mount covers it. The mount is the last one, in mountinfo's order (the order they were
 * mounted), whose mount point holds the path: a later mount over a parent folder hides an
 * earlier one deeper down, and of several at one point the last is on top.
 */
export const fsPathOf = (mounts: ReadonlyArray<Mount>, path: string): string | null => {
  const mount = mounts.findLast((candidate) => under(candidate.mountPoint, path));

  if (mount === undefined) return null;

  const below = mount.mountPoint === "/" ? path : path.slice(mount.mountPoint.length);
  const joined = `${mount.root === "/" ? "" : mount.root}${below === "/" ? "" : below}`;

  return `${mount.device}:${joined === "" ? "/" : joined}`;
};
