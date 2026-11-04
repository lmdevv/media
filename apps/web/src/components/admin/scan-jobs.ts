import type { LibraryId } from "@media/contracts/ids";
import type { Job } from "@media/contracts/models/jobs";
import { folderTroubleOf } from "@media/contracts/scan-failure";
import { useCommandQuery } from "@media/sdk/react";
import { useMemo } from "react";

const RECENT_SCANS = 100;

/** Each library's most recent scan job, live, so rows show progress as the media service reports it. */
export const useLatestScans = (): ReadonlyMap<LibraryId, Job> => {
  const jobs = useCommandQuery("jobs.list", { kind: "scan", limit: RECENT_SCANS });

  return useMemo(() => {
    const latest = new Map<LibraryId, Job>();

    if (jobs.status !== "success") return latest;

    for (const job of jobs.data) {
      if (job.payload.kind === "scan" && !latest.has(job.payload.libraryId)) {
        latest.set(job.payload.libraryId, job);
      }
    }

    return latest;
  }, [jobs]);
};

/** Whether a job is still queued or running. */
export const isActive = (job: Job | undefined): boolean =>
  job !== undefined && (job.status === "pending" || job.status === "running");

/** Whether a failed scan could not read the library's folders, such as an offline NAS share. */
export const isUnreachable = (job: Job): boolean =>
  job.status === "failed" && folderTroubleOf(job.error) === "offline";
