/**
 * The folders typed on Add your music (E05), checked before any library is made: each is an
 * absolute path on the server, named after its last part, and none repeats. Blank extra fields
 * are left out, but the first folder is required.
 */

/** A folder to add as a library. */
interface NewFolder {
  readonly name: string;
  readonly path: string;
}

/** The folders to add, or the first field that can't be used and why. */
export type FoldersResult =
  | { readonly ok: true; readonly folders: ReadonlyArray<NewFolder> }
  | { readonly ok: false; readonly index: number; readonly message: string };

/** A library's name from its folder: the last part of the path, or Music for the root. */
const folderName = (path: string): string =>
  path.split("/").findLast((part) => part.length > 0) ?? "Music";

/** Parses the typed folders, in order. */
export const parseFolders = (texts: ReadonlyArray<string>): FoldersResult => {
  const folders: Array<NewFolder> = [];

  for (const [index, text] of texts.entries()) {
    const path = text.trim();

    if (path === "" && index > 0) continue;

    if (!path.startsWith("/")) {
      return {
        ok: false,
        index,
        message: "Use an absolute path the server can read, such as /music.",
      };
    }

    if (folders.some((folder) => folder.path === path)) {
      return { ok: false, index, message: "This folder is already on the list." };
    }

    folders.push({ name: folderName(path), path });
  }

  return { ok: true, folders };
};
