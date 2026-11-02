import type { Fingerprint, ScannedTrack } from "./media-backend.ts";

const isSameSong = (gone: Fingerprint, found: ScannedTrack): boolean =>
  gone.size === found.size &&
  gone.durationMs === found.durationMs &&
  (gone.mtimeMs === found.mtimeMs ||
    (gone.title === found.title && gone.artist === found.artist && gone.album === found.album));

/**
 * Matches new files to the tracks in `gone` (known tracks whose files a scan did not find,
 * missing or not). Each gone track matches at most one new file: the first one asked about.
 *
 * @returns A lookup from a scanned new file to the path of the gone track it is, or `undefined`
 *   when none or more than one gone track matches it.
 */
export const movedFileMatcher = (
  gone: ReadonlyArray<Fingerprint>,
): ((found: ScannedTrack) => string | undefined) => {
  const bySize = Map.groupBy(gone, (file) => file.size);
  const taken = new Set<string>();

  return (found) => {
    const matches = (bySize.get(found.size) ?? []).filter(
      (file) => !taken.has(file.path) && isSameSong(file, found),
    );

    const [only] = matches;

    if (only === undefined || matches.length > 1) return undefined;
    taken.add(only.path);

    return only.path;
  };
};
