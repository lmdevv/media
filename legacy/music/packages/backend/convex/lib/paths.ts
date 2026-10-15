/**
 * Library folder paths. Two libraries must not overlap: a folder inside another library's folder
 * would index the same files twice, as two catalogs.
 */

/**
 * The canonical form of an absolute folder path: single slashes, no `.` or `..` segments, and no
 * trailing slash (except the root itself). Returns null for a relative path.
 */
export const normaliseLibraryPath = (raw: string): string | null => {
  if (!raw.startsWith("/")) return null;

  const segments: Array<string> = [];

  for (const segment of raw.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }

  return `/${segments.join("/")}`;
};

/** How a folder sits relative to another one, both normalised. */
export type Overlap = "same" | "inside" | "contains" | "apart";

const within = (inner: string, outer: string): boolean =>
  outer === "/" ? inner !== "/" : inner.startsWith(`${outer}/`);

/** Whether `path` is `other`, is inside it, contains it, or neither. Segment-aware. */
export const overlapOf = (path: string, other: string): Overlap => {
  if (path === other) return "same";

  if (within(path, other)) return "inside";

  return within(other, path) ? "contains" : "apart";
};

/** The folder names a library is known by: the path it was added with, and the real one. */
interface Rooted {
  readonly path: string;
  readonly realPath?: string | undefined;
}

/**
 * Whether the media service has claimed a library's folder (`media:claimRoot`), so its files may
 * be read. A library from before claims, or one whose claim was refused, streams nothing.
 */
export const isClaimed = <Library extends Rooted>(
  library: Library | null,
): library is Library & { readonly realPath: string } =>
  library !== null && library.realPath !== undefined;

/**
 * The first library in `libraries` whose folder overlaps `path` (normalised), and how. A library
 * is compared by the path it was added with and, once the media service has resolved it, by its
 * real path too: a link can name the same files under a different path. A bind mount can too,
 * which paths can't see; `media:claimRoot` compares folder identities for that.
 */
export const firstOverlap = <Library extends Rooted>(
  libraries: ReadonlyArray<Library>,
  path: string,
): { readonly library: Library; readonly overlap: Exclude<Overlap, "apart"> } | null => {
  for (const library of libraries) {
    const names = [normaliseLibraryPath(library.path) ?? library.path, library.realPath];

    for (const name of names) {
      if (name === undefined) continue;
      const overlap = overlapOf(path, name);

      if (overlap !== "apart") return { library, overlap };
    }
  }

  return null;
};
