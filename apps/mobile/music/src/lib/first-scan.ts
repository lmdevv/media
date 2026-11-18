import type { PlatformSdk } from "@media/sdk/promise";

export type LibraryView = Awaited<ReturnType<PlatformSdk["core"]["libraries"]["get"]>>;

export type LibraryId = LibraryView["libraryId"];

/** What the scan screens show. */
export type FirstScan =
  /** Reading files: the share read so far, when the server knows the total, and time left. */
  | { readonly kind: "running"; readonly percent: number | null; readonly left: string | null }
  /** The library has been read (E07). */
  | { readonly kind: "done" }
  /** The scan stopped (G09); `folders` are the library's folders, to show which one. */
  | { readonly kind: "stopped"; readonly folders: ReadonlyArray<string> };

type ScanLibrary = Pick<LibraryView, "folders" | "scan">;

const MINUTE_MS = 60_000;

const timeLeft = (scan: NonNullable<ScanLibrary["scan"]>, now: number): string | null => {
  if (scan.status === "queued") return "WAITING FOR THE SCANNER";

  if (scan.total === null) return "COUNTING FILES";

  const done = scan.done ?? 0;

  if (scan.startedAt === null || done === 0 || done >= scan.total) return null;

  const rate = done / Math.max(1, now - scan.startedAt);
  const minutes = Math.ceil((scan.total - done) / rate / MINUTE_MS);

  return minutes <= 1 ? "UNDER A MINUTE LEFT" : `ABOUT ${String(minutes)} MIN LEFT`;
};

/**
 * Where the first scan of the library made during setup stands at `now`, in milliseconds since
 * the epoch, from its latest scan as `core.libraries.get` keeps it.
 */
export const firstScan = (library: ScanLibrary, now: number): FirstScan => {
  const { scan } = library;

  if (scan === null) return { kind: "running", percent: null, left: "WAITING FOR THE SCANNER" };

  if (scan.status === "failed" || scan.status === "canceled") {
    return { kind: "stopped", folders: library.folders ?? [] };
  }

  if (scan.status === "succeeded") return { kind: "done" };

  const done = scan.done ?? 0;

  const percent =
    scan.total === null || scan.total === 0
      ? null
      : Math.min(100, Math.floor((done / scan.total) * 100));

  return { kind: "running", percent, left: timeLeft(scan, now) };
};
