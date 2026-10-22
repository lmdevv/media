/**
 * Where the first scan of a new server stands (E06, E07, G09), from the libraries and their scan
 * jobs. Every library's latest job counts, so folders added together read as one scan.
 */
import type { LibraryId } from "@music/commands/ids";
import type { Job, Library } from "@music/commands/models";

/** What the scan screens show. */
export type FirstScan =
  /** Reading files: the share read so far, when the server knows the total, and time left. */
  | { readonly kind: "running"; readonly percent: number | null; readonly left: string | null }
  /** Every library has been read (E07). */
  | { readonly kind: "done" }
  /** A library's scan stopped (G09); `added` is how many songs made it in before it did. */
  | {
      readonly kind: "stopped";
      readonly libraryId: LibraryId;
      readonly path: string | null;
      readonly added: number;
    };

type ScanLibrary = Pick<Library, "id" | "path" | "lastScanAt" | "scanning" | "trackCount">;

type ScanJob = Pick<Job, "libraryId" | "status" | "done" | "total" | "createdAt" | "startedAt">;

const MINUTE_MS = 60_000;

/** Each library's newest job, if it has one. */
const latestJobs = (
  libraries: ReadonlyArray<ScanLibrary>,
  jobs: ReadonlyArray<ScanJob>,
): ReadonlyArray<ScanJob> =>
  libraries.flatMap((library) => {
    const own = jobs.filter((job) => job.libraryId === library.id);

    const latest = own.reduce<ScanJob | null>(
      (newest, job) => (newest === null || job.createdAt > newest.createdAt ? job : newest),
      null,
    );

    return latest === null ? [] : [latest];
  });

/**
 * `ABOUT 2 MIN LEFT` from the rate so far, or null until there is enough to estimate. Jobs still
 * waiting for the scanner, or still counting what to read, say so instead.
 */
const timeLeft = (
  jobs: ReadonlyArray<ScanJob>,
  done: number,
  total: number | null,
  now: number,
) => {
  if (jobs.every((job) => job.status === "pending")) return "WAITING FOR THE SCANNER";

  if (total === null) return "COUNTING FILES";

  const started = jobs.flatMap((job) => (job.startedAt === null ? [] : [job.startedAt]));

  if (started.length === 0 || done === 0 || done >= total) return null;

  const rate = done / Math.max(1, now - Math.min(...started));
  const minutes = Math.ceil((total - done) / rate / MINUTE_MS);

  return minutes <= 1 ? "UNDER A MINUTE LEFT" : `ABOUT ${String(minutes)} MIN LEFT`;
};

/** Where the first scan stands at `now`, in milliseconds since the epoch. */
export const firstScan = (
  libraries: ReadonlyArray<ScanLibrary>,
  jobs: ReadonlyArray<ScanJob>,
  now: number,
): FirstScan => {
  const latest = latestJobs(libraries, jobs);
  const stopped = latest.find((job) => job.status === "failed" || job.status === "cancelled");
  const added = libraries.reduce((sum, library) => sum + library.trackCount, 0);

  if (stopped !== undefined && stopped.libraryId !== null) {
    const path = libraries.find((library) => library.id === stopped.libraryId)?.path ?? null;

    return { kind: "stopped", libraryId: stopped.libraryId, path, added };
  }

  if (
    libraries.length > 0 &&
    libraries.every((library) => library.lastScanAt !== null && !library.scanning)
  ) {
    return { kind: "done" };
  }

  const done = latest.reduce((sum, job) => sum + job.done, 0);
  const totals = latest.map((job) => job.total);

  const total = totals.includes(null)
    ? null
    : totals.reduce<number>((sum, count) => sum + (count ?? 0), 0);

  const percent =
    total === null || total === 0 ? null : Math.min(100, Math.floor((done / total) * 100));

  return { kind: "running", percent, left: timeLeft(latest, done, total, now) };
};
