import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { PageHeader } from "@media/ui/components/page-header";
import { useFirstRows, usePages } from "@media/ui/lib/pages";
import type { Paged } from "@media/ui/lib/pages";
import { useState } from "react";
import type { ReactNode } from "react";

import { useActions } from "./action";
import { KIND_LABELS } from "./libraries";
import { ItemRow, PagedList, formatTime } from "./parts";
import type { Job, LibraryId } from "./types";

/** Which jobs the list shows: all of them, or the failed ones. */
export type JobFilter = "all" | "failed";

/** The failed jobs counted in the filter's label; more shows as `100+`. */
const FAILED_COUNTED = 100;

const STATUS: Readonly<Record<Job["status"], string>> = {
  queued: "Waiting",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  canceled: "Canceled",
};

/** What a job of each kind other than a scan is called; a scan is called by its library. */
const KIND_TITLES: Readonly<Record<Exclude<Job["kind"], `${string}.scan`>, string>> = {
  "movies.metadata": "Metadata lookup",
  "movies.person": "Person lookup",
  "movies.trickplay": "Scrub thumbnails",
  "movies.import.jellyfin": "Import from Jellyfin",
  "movies.import.plex": "Import from Plex",
  "music.lyrics": "Lyrics lookup",
  "server.backup": "Backup",
};

/** Whether a job is still waiting or running. */
const isActive = (job: Pick<Job, "status">): boolean =>
  job.status === "queued" || job.status === "running";

/** A job's name in the list: a scan's library, or what the job does. */
export const jobTitle = (job: Job): string =>
  job.kind === "movies.scan" || job.kind === "music.scan"
    ? (job.library?.name ?? "Scan")
    : KIND_TITLES[job.kind];

/**
 * What a job's row says on its second line: its library's kind for a scan, its status, how far
 * it got while it runs, its attempt once it was tried again, and when it ended.
 */
export const jobFacts = (job: Job): string => {
  const kind =
    job.library === null ? null : KIND_LABELS[job.kind === "music.scan" ? "music" : "movies"];

  const progress =
    job.status === "running" ? ` · ${job.done}${job.total === null ? "" : ` / ${job.total}`}` : "";

  const attempt = job.attempts > 1 ? ` · attempt ${job.attempts}` : "";
  const ended = job.finishedAt === null ? "" : ` · ${formatTime(job.finishedAt)}`;

  return `${kind === null ? "" : `${kind} · `}${STATUS[job.status]}${progress}${attempt}${ended}`;
};

/**
 * Jobs: the server's jobs of every kind, newest first, with their progress, attempts, and errors,
 * and a way to stop a library's scan or run a failed one again, as old music's jobs page did for
 * its scans. The failed ones are counted, as old music counted its recent ones.
 */
export function JobsScreen() {
  const platform = usePlatform();
  const [filter, setFilter] = useState<JobFilter>("all");
  const all = usePages(platform.core.jobs.list, (paginationOpts) => ({ paginationOpts }));

  const failed = useFirstRows(
    platform.core.jobs.list,
    (paginationOpts) => ({ status: "failed" as const, paginationOpts }),
    FAILED_COUNTED,
  );

  return (
    <JobsView
      jobs={filter === "failed" ? failed : all}
      failed={failed}
      filter={filter}
      onFilter={setFilter}
      row={(job) => <JobRow job={job} />}
    />
  );
}

/** How many failed jobs the label counts: all of them, `100+` past that, or nothing while counting. */
const failedCount = (failed: Paged<Job>): string => {
  if (failed.status !== "ready") return "";

  if (failed.next.kind === "done" && failed.rows.length <= FAILED_COUNTED) {
    return ` · ${failed.rows.length}`;
  }

  return failed.rows.length >= FAILED_COUNTED ? ` · ${FAILED_COUNTED}+` : "";
};

/** The jobs list, all of them or the failed ones. */
export function JobsView({
  jobs,
  failed,
  filter,
  onFilter,
  row,
}: {
  readonly jobs: Paged<Job>;
  /** The failed jobs, counted in the filter's label. */
  readonly failed: Paged<Job>;
  readonly filter: JobFilter;
  readonly onFilter: (filter: JobFilter) => void;
  /** A job's row, with its actions. */
  readonly row: (job: Job) => ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Jobs"
        actions={
          <div role="group" aria-label="Show" className="flex gap-1">
            <Button
              variant={filter === "all" ? "raised" : "ghost"}
              size="xs"
              aria-pressed={filter === "all"}
              onClick={() => onFilter("all")}
            >
              All
            </Button>
            <Button
              variant={filter === "failed" ? "raised" : "ghost"}
              size="xs"
              aria-pressed={filter === "failed"}
              onClick={() => onFilter("failed")}
            >
              {`Failed${failedCount(failed)}`}
            </Button>
          </div>
        }
      />
      <PagedList
        label="Jobs"
        list={jobs}
        empty={filter === "failed" ? "No failed jobs." : "No jobs yet."}
        rowKey={(job) => job.jobId}
      >
        {row}
      </PagedList>
    </>
  );
}

function JobRow({ job }: { readonly job: Job }) {
  const platform = usePlatform();
  const actions = useActions<"cancel" | "retry">();

  return (
    <JobRowView
      job={job}
      running={actions.running}
      onCancel={(scan) =>
        void actions.run(
          "cancel",
          () => platform.core.libraries.cancelScan({ jobId: scan.jobId, attempt: scan.attempts }),
          "Asked the scan to stop",
        )
      }
      onRetry={(libraryId) =>
        void actions.run(
          "retry",
          () => platform.core.libraries.scan({ libraryId }),
          "Started the scan again",
        )
      }
    />
  );
}

/**
 * One job, with Cancel while a library's scan runs and Retry after it failed, to whoever may do
 * more than view the library.
 */
export function JobRowView({
  job,
  running,
  onCancel,
  onRetry,
}: {
  readonly job: Job;
  readonly running: "cancel" | "retry" | null;
  readonly onCancel: (scan: Job) => void;
  readonly onRetry: (libraryId: LibraryId) => void;
}) {
  const { library } = job;
  const manages = library !== null && library.level !== "view";
  const active = isActive(job);

  const action =
    library === null || !manages ? null : active ? (
      <Button
        variant="raised"
        size="xs"
        disabled={running !== null || job.canceling}
        onClick={() => onCancel(job)}
      >
        {job.canceling || running === "cancel" ? "Canceling…" : "Cancel"}
      </Button>
    ) : job.status === "failed" ? (
      <Button
        variant="raised"
        size="xs"
        disabled={running !== null}
        onClick={() => onRetry(library.libraryId)}
      >
        {running === "retry" ? "Starting…" : "Retry"}
      </Button>
    ) : null;

  return (
    <ItemRow title={jobTitle(job)} facts={jobFacts(job)} actions={action}>
      {job.error === null ? null : (
        <p className="font-mono text-caption/caption break-all text-danger">{job.error}</p>
      )}
      {active && job.message !== null ? (
        <p className="truncate font-mono text-caption/caption text-text-muted">{job.message}</p>
      ) : null}
    </ItemRow>
  );
}
