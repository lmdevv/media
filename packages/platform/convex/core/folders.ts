import { normalizeFolder } from "@media/contracts/library-folder";

import type { Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { fail } from "./lib/errors";

/** Most folders one library has. */
export const FOLDERS_MAX = 16;

const FOLDER_CHARS_MAX = 1024;

const CONTROL = /\p{Cc}/u;

const hasDotSegment = (path: string): boolean =>
  path.split("/").some((segment) => segment === "." || segment === "..");

/**
 * A typed folder as stored and compared, written down by `normalizeFolder` as the web app does.
 * Refuses with `invalid_args` a relative path, a `.` or `..` segment, a control
 * character, `/` itself, which would hold every other library, and more than 1,024 characters.
 */
export const parseFolder = (typed: string): string => {
  const folder = normalizeFolder(typed);

  if (!folder.startsWith("/") || hasDotSegment(folder) || CONTROL.test(folder)) {
    return fail("invalid_args", `Folders are absolute paths without . or .. parts: ${typed}`);
  }

  if (folder === "/") return fail("invalid_args", "A library cannot hold the whole disk");

  return folder.length > FOLDER_CHARS_MAX
    ? fail("invalid_args", `Folders have at most ${FOLDER_CHARS_MAX} characters`)
    : folder;
};

/** Whether `path` is `folder` or lies inside it; both parsed. */
export const isInside = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);

/**
 * A library's folders: 1 to 16 parsed folders without repeats, none inside another of them.
 * Refuses with `invalid_args`.
 */
export const parseFolders = (typed: ReadonlyArray<string>): ReadonlyArray<string> => {
  const folders = [...new Set(typed.map(parseFolder))].toSorted();

  if (folders.length === 0) return fail("invalid_args", "Add at least one folder");

  if (folders.length > FOLDERS_MAX) {
    return fail("invalid_args", `A library has at most ${FOLDERS_MAX} folders`);
  }

  const nested = folders.find((folder) =>
    folders.some((outer) => outer !== folder && isInside(folder, outer)),
  );

  return nested === undefined
    ? folders
    : fail("invalid_args", `${nested} is inside another folder of this library`);
};

/** `/a/b/c` gives `/a`, `/a/b`, and `/a/b/c`: the folder and every folder that holds it. */
export const selfAndAncestors = (folder: string): ReadonlyArray<string> =>
  folder
    .split("/")
    .slice(1)
    .map((_, index, segments) => `/${segments.slice(0, index + 1).join("/")}`);

/** A library's folders, in path order: at most 16 rows. */
export const foldersOf = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
): Promise<ReadonlyArray<string>> =>
  (
    await db
      .query("libraryFolders")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .take(FOLDERS_MAX)
  ).map((row) => row.path);

/**
 * Whether another library has `folder`, a folder that holds it, or a folder inside it. Reads one
 * index entry per segment of `folder` and one range of at most 17 entries, whatever the number of
 * libraries, private ones included. A concurrent claim of an overlapping folder writes a key this
 * read, so Convex runs the two one after the other.
 */
const takenByOther = async (
  db: DatabaseReader,
  folder: string,
  libraryId: Id<"libraries">,
): Promise<boolean> => {
  const [holders, inside] = await Promise.all([
    Promise.all(
      selfAndAncestors(folder).map((path) =>
        db
          .query("libraryFolders")
          .withIndex("by_path", (q) => q.eq("path", path))
          .take(2),
      ),
    ),
    db
      .query("libraryFolders")
      .withIndex("by_path", (q) => q.gte("path", `${folder}/`).lt("path", `${folder}0`))
      .take(FOLDERS_MAX + 1),
  ]);

  return [...holders.flat(), ...inside].some((row) => row.libraryId !== libraryId);
};

/**
 * Makes `folders`, parsed, the library's folders, and says which it added and removed. A folder
 * that another library has, holds, or lies in fails `conflict` with a message that names only the
 * folder the caller typed, so it tells no one about a library they cannot see. Two libraries never
 * share files, whatever their kinds, so a grant on one never shows the other's.
 */
export const claimFolders = async (
  ctx: Pick<MutationCtx, "db">,
  libraryId: Id<"libraries">,
  folders: ReadonlyArray<string>,
): Promise<{ readonly added: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> }> => {
  const current = await ctx.db
    .query("libraryFolders")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
    .take(FOLDERS_MAX);

  const leaving = current.filter((row) => !folders.includes(row.path));
  const added = folders.filter((folder) => !current.some((row) => row.path === folder));

  await Promise.all(leaving.map((row) => ctx.db.delete(row._id)));

  const taken = await Promise.all(
    added.map(async (folder) => ((await takenByOther(ctx.db, folder, libraryId)) ? [folder] : [])),
  );

  const [overlap] = taken.flat();

  if (overlap !== undefined) {
    fail(
      "conflict",
      `Another library already uses ${overlap}, a folder that holds it, or one inside it`,
    );
  }

  await Promise.all(added.map((path) => ctx.db.insert("libraryFolders", { libraryId, path })));

  return { added, removed: leaving.map((row) => row.path) };
};

/** Frees every folder of a library that is being deleted, so another library may take them. */
export const releaseFolders = async (
  ctx: Pick<MutationCtx, "db">,
  libraryId: Id<"libraries">,
): Promise<void> => {
  const rows = await ctx.db
    .query("libraryFolders")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
    .take(FOLDERS_MAX);

  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
};
