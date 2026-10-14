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
