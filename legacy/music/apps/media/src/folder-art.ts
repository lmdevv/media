/**
 * Folder artwork: the `cover.jpg` (or `folder`, `front`; JPEG, PNG, or WebP) beside a song that
 * has no picture of its own. A song in a disc folder (`Album/CD1/`, `Album/Disc 2/`) uses the
 * album folder's artwork when its own folder has none.
 */
import { basename, dirname } from "node:path";

import type { WalkedFile } from "./platform/node-files.ts";

const FOLDER_ART = /^(cover|folder|front)\.(jpe?g|png|webp)$/iu;

const FOLDER_ART_ORDER = ["cover", "folder", "front"];

/** `CD1`, `CD 2`, `Disc 01`, `disk-3`, `Disc 2 - Bonus`: one disc of a multi-disc album. */
const DISC_FOLDER = /^(?:cd|dis[ck])[\s._-]*\d+\b/iu;

/** True when a file name is one of the folder artwork names. */
export const isFolderArt = (name: string): boolean => FOLDER_ART.test(name);

const rank = (name: string): number =>
  FOLDER_ART_ORDER.indexOf(name.slice(0, name.lastIndexOf(".")).toLowerCase());

/**
 * Finds the folder artwork for songs from the artwork files a library walk found (paths relative
 * to the library, `/`-separated): the best-ranked one in the song's folder, else, for a disc
 * folder, the best-ranked one in its parent.
 *
 * @returns A lookup from a song's library-relative folder (`.` for the library root) to its
 *   artwork file, or `undefined` when it has none.
 */
export const folderArtLookup = (
  artFiles: ReadonlyArray<WalkedFile>,
): ((folder: string) => WalkedFile | undefined) => {
  const best = new Map<string, WalkedFile>();

  for (const file of artFiles) {
    const folder = dirname(file.relativePath);
    const current = best.get(folder);
    const name = basename(file.relativePath);

    if (current === undefined || rank(name) < rank(basename(current.relativePath))) {
      best.set(folder, file);
    }
  }

  return (folder) => {
    const own = best.get(folder);

    if (own !== undefined || folder === "." || !DISC_FOLDER.test(basename(folder))) return own;

    return best.get(dirname(folder));
  };
};

/**
 * Identifies one version of an artwork file, `path:size:mtime`. A song whose stored key differs
 * from its folder's current one is read again, so a replaced cover reaches the catalog.
 */
export const folderArtKey = (file: WalkedFile | undefined): string | undefined =>
  file === undefined ? undefined : `${file.relativePath}:${file.size}:${Math.trunc(file.mtimeMs)}`;
