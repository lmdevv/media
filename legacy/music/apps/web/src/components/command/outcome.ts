import type { Job } from "@music/commands/models";

/** The line under a job's title: the result once it ends, or a note that it runs on its own. */
export const jobMeta = (job: Job | undefined): string => {
  // The scanner's summary, such as "28 files, 0 updated, 0 missing".
  if (job?.status === "done") return job.message ?? "Finished.";

  if (job?.status === "failed") return job.error ?? "The job failed.";

  return "Runs in the background. Close this any time.";
};
