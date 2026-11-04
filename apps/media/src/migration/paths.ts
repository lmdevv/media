/**
 * Source paths to local paths. Jellyfin and Plex report files as their own host sees them, which
 * may be another machine, a container, or Windows. A path mapping rewrites a source folder prefix
 * to a folder on this host; a source folder already inside an approved library root needs none.
 *
 * Paths compare after normalization: forward slashes, no repeated or trailing slashes, and Unicode
 * NFC (macOS and some NAS shares store decomposed names). Windows drive paths compare without
 * case, as Windows does; POSIX paths compare exactly.
 */
import type { PathMapping } from "@media/contracts/models/migration";

const DRIVE = /^[A-Za-z]:\//u;

/** Normalizes a path for comparison. */
export const normalizePath = (path: string): string => {
  // Not trimmed: folder names may end in spaces.
  const slashed = path
    .normalize("NFC")
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/");

  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/u, "") : slashed;

  return DRIVE.test(`${trimmed}/`) && trimmed.length === 2 ? `${trimmed}/` : trimmed;
};

const comparable = (path: string): string => (DRIVE.test(path) ? path.toLowerCase() : path);

const relativeTo = (path: string, folder: string): string | null => {
  const left = comparable(normalizePath(path));
  const right = comparable(normalizePath(folder));

  if (left === right) return "";
  const prefix = right.endsWith("/") ? right : `${right}/`;

  return left.startsWith(prefix) ? normalizePath(path).slice(prefix.length) : null;
};

/** Whether `path` is `folder` or inside it. */
export const isInside = (path: string, folder: string): boolean =>
  relativeTo(path, folder) !== null;

const join = (folder: string, relative: string): string =>
  relative === "" ? folder : `${folder === "/" ? "" : folder}/${relative}`;

/**
 * The local path of a source path: through the mapping with the longest matching `from`, or the
 * path itself when it already lies inside an approved root. Null when neither applies.
 */
export const toLocalPath = (
  sourcePath: string,
  mappings: ReadonlyArray<PathMapping>,
  roots: ReadonlyArray<string>,
): string | null => {
  const mapped = mappings
    .flatMap((mapping) => {
      const relative = relativeTo(sourcePath, mapping.from);

      return relative === null ? [] : [{ mapping, relative }];
    })
    .toSorted(
      (left, right) =>
        normalizePath(right.mapping.from).length - normalizePath(left.mapping.from).length,
    )[0];

  if (mapped !== undefined) {
    return join(normalizePath(mapped.mapping.to), mapped.relative);
  }

  const normalized = normalizePath(sourcePath);

  return roots.some((root) => isInside(normalized, root)) ? normalized : null;
};

const segmentsOf = (path: string): ReadonlyArray<string> =>
  normalizePath(path)
    .split("/")
    .filter((segment) => segment !== "" && !/^[A-Za-z]:$/u.test(segment));

/**
 * Local folders that could hold `sourceFolder`, most likely first: the root itself when its name
 * matches the folder's, then the folder's last one and two segments under each root. A source
 * `/data/movies` and a root `/mnt/nas/movies` give `/mnt/nas/movies`; a root `/mnt/nas` gives
 * `/mnt/nas/movies` and `/mnt/nas/data/movies`.
 */
export const mappingCandidates = (
  sourceFolder: string,
  roots: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const segments = segmentsOf(sourceFolder);
  const last = segments.at(-1);

  if (last === undefined) return [];
  const tails = [segments.slice(-1), segments.slice(-2)].filter((tail) => tail.length > 0);

  const candidates = roots.flatMap((root) => {
    const normalized = normalizePath(root);
    const sameName = segmentsOf(normalized).at(-1) === last ? [normalized] : [];

    return [...sameName, ...tails.map((tail) => join(normalized, tail.join("/")))];
  });

  return [...new Set(candidates)];
};
