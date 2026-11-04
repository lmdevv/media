import type { Doc, Id } from "../_generated/dataModel";
import { LIBRARY_ROOT_MAX, LIBRARY_ROOTS_MAX } from "./bounds";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/**
 * A folder as stored and compared: trimmed, repeated slashes collapsed, and any trailing run of
 * slashes and whitespace dropped (`/` stays), in one pass. Mirrors `normalizeFolder` in
 * `@media/contracts/library-folder`, which the web app uses; `test/library-folder.test.ts`
 * checks they agree. A blank folder stays blank, so `checkAbsolute` refuses it rather than taking
 * it for `/`.
 */
export const normalizeRoot = (root: string): string =>
  root
    .trim()
    .replace(/\/{2,}/gu, "/")
    .replace(/(?<=.)[\s/]+$/u, "");

/** Whether `path` is `root` or lies inside it; both normalized. */
export const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? root : `${root}/`);

const overlaps = (left: string, right: string): boolean =>
  isInside(left, right) || isInside(right, left);

/** The libraries with a folder that holds `folder`, lies inside it, or is it. */
export const librariesOverlapping = (
  folder: string,
  libraries: ReadonlyArray<Doc<"libraries">>,
): Array<Doc<"libraries">> =>
  libraries.filter((library) =>
    library.roots.some((known) => overlaps(folder, normalizeRoot(known))),
  );

const hasDotSegment = (path: string): boolean =>
  path.split("/").some((segment) => segment === "." || segment === "..");

/** Whether a scanned path lies in one of a library's folders, with no segment leading out. */
export const isInLibrary = (path: string, library: Doc<"libraries">): boolean =>
  !hasDotSegment(path) && library.roots.some((root) => isInside(path, root));

/** Requires normalized folders to be absolute, without `.` or `..` segments. */
export const checkAbsolute = (folders: ReadonlyArray<string>): void => {
  const invalid = folders.find((root) => !root.startsWith("/") || hasDotSegment(root));

  if (invalid !== undefined) fail("invalid_args", `Folders must be absolute paths: ${invalid}`);
};

/**
 * Normalizes and checks library folders: absolute, at most 1024 characters, without `.` or `..`
 * segments, and neither the same as, inside, nor containing a folder of another library (other
 * than `except`). Nested libraries would let a grant on one expose the other's files.
 */
export const checkRoots = async (
  ctx: ReadCtx,
  roots: ReadonlyArray<string>,
  except: Id<"libraries"> | null,
): Promise<Array<string>> => {
  const normalized = [...new Set(roots.map(normalizeRoot))];

  if (normalized.length === 0) return fail("invalid_args", "Add at least one folder");

  if (normalized.length > LIBRARY_ROOTS_MAX) {
    return fail("invalid_args", `A library has at most ${LIBRARY_ROOTS_MAX} folders`);
  }

  checkAbsolute(normalized);

  const long = normalized.find((root) => root.length > LIBRARY_ROOT_MAX);

  if (long !== undefined) {
    return fail("invalid_args", `Folders have at most ${LIBRARY_ROOT_MAX} characters`);
  }

  const others = (await ctx.db.query("libraries").collect()).filter(
    (other) => other._id !== except,
  );

  const nested = normalized.find((root) =>
    normalized.some((outer) => outer !== root && isInside(root, outer)),
  );

  if (nested !== undefined) {
    return fail("invalid_args", `${nested} is inside another folder of this library`);
  }

  for (const other of others) {
    for (const known of other.roots.map(normalizeRoot)) {
      const overlap = normalized.find((root) => overlaps(root, known));

      if (overlap === known) return fail("conflict", `Another library already uses ${known}`);

      if (overlap !== undefined) {
        return fail(
          "invalid_args",
          isInside(overlap, known)
            ? `${overlap} is inside ${known}, a folder of the library "${other.name}"`
            : `${overlap} contains ${known}, a folder of the library "${other.name}"`,
        );
      }
    }
  }

  return normalized;
};

/** The folders not inside another of `roots`: what a library over all of them would need. */
export const outermostRoots = (roots: ReadonlyArray<string>): Array<string> =>
  roots.filter((root) => !roots.some((outer) => outer !== root && isInside(root, outer)));

/**
 * Pairs of libraries whose folders overlap, as libraries made before folders were kept apart may.
 * A grant on either exposes files of the other; `maintenance:overlappingLibraries` lists them.
 */
export const overlappingLibraries = (
  libraries: ReadonlyArray<Doc<"libraries">>,
): Array<{ readonly outer: string; readonly inner: string; readonly folder: string }> =>
  libraries.flatMap((outer) =>
    libraries.flatMap((inner) =>
      outer._id === inner._id
        ? []
        : inner.roots.flatMap((folder) =>
            outer.roots.some((root) => {
              const normalized = normalizeRoot(root);
              const candidate = normalizeRoot(folder);

              return (
                isInside(candidate, normalized) &&
                (candidate !== normalized || outer._creationTime < inner._creationTime)
              );
            })
              ? [{ outer: outer.name, inner: inner.name, folder }]
              : [],
          ),
    ),
  );
