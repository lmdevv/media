import { usePlatform } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { PageHeader } from "@media/ui/components/page-header";
import { useEachQuery } from "@media/ui/lib/each-query";
import { useAllPages } from "@media/ui/lib/pages";
import type { Paged } from "@media/ui/lib/pages";
import { useState } from "react";
import type { ReactNode } from "react";

import { useActions } from "./action";
import { KIND_LABELS } from "./libraries";
import { Failed, ItemRow, PagedList, formatTime } from "./parts";
import type { Library, LibraryDetail, LibraryId } from "./types";

/** A library's latest scan, its one kind of job. */
export type Scan = NonNullable<LibraryDetail["scan"]>;

/** Which jobs the list shows: all of them, or the failed ones. */
export type JobFilter = "all" | "failed";

const STATUS: Readonly<Record<Scan["status"], string>> = {
  queued: "Waiting",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  canceled: "Canceled",
};

/** Whether a scan is still waiting or running. */
const isActive = (scan: Scan): boolean => scan.status === "queued" || scan.status === "running";

/** What a scan's row says on its second line: its progress, its error, or when it ended. */
export const jobFacts = (library: Pick<Library, "kind">, scan: Scan | null): string => {
  const kind = KIND_LABELS[library.kind];

  if (scan === null) return `${kind} · Never scanned`;

  const progress =
    scan.status === "running" && scan.done !== null
      ? ` · ${scan.done}${scan.total === null ? "" : ` / ${scan.total}`} files`
      : "";

  const ended = scan.finishedAt === null ? "" : ` · ${formatTime(scan.finishedAt)}`;

  return `${kind} · ${STATUS[scan.status]}${progress}${ended}`;
};

/** A library with its latest scan's state, read from `core.libraries.get`. */
export interface Job {
  readonly library: Library;
  readonly detail: QueryState<LibraryDetail>;
}

/** Whether a job's latest scan failed. */
const isFailed = (job: Job): boolean =>
  job.detail.status === "success" && job.detail.data.scan?.status === "failed";

/**
 * Jobs: every library's latest scan, with its progress, its error, and a way to stop a scan or
 * run a failed one again. Old music's jobs page listed its scans; the core's jobs are each
 * library's scan, so the page lists the libraries shared with this admin (D57), all of them and
 * each one's scan at once, so the failed ones can be counted as old music did.
 */
export function JobsScreen() {
  const platform = usePlatform();
  const [filter, setFilter] = useState<JobFilter>("all");

  const libraries = useAllPages(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const rows = libraries.status === "ready" ? libraries.rows : [];

  const details = useEachQuery(
    platform.core.libraries.get,
    rows.map((library) => ({ libraryId: library.libraryId })),
  );

  const jobs: Paged<Job> =
    libraries.status === "ready"
      ? {
          ...libraries,
          rows: libraries.rows.map((library, index) => ({
            library,
            detail: details[index] ?? { status: "loading" },
          })),
        }
      : libraries;

  return (
    <JobsView
      jobs={jobs}
      filter={filter}
      onFilter={setFilter}
      row={(job) => <JobRow job={job} />}
    />
  );
}

/** The jobs list: a row per library, filtered to the failed ones on request. */
export function JobsView({
  jobs,
  filter,
  onFilter,
  row,
}: {
  readonly jobs: Paged<Job>;
  readonly filter: JobFilter;
  readonly onFilter: (filter: JobFilter) => void;
  /** A job's row, with its actions. */
  readonly row: (job: Job) => ReactNode;
}) {
  const failed = jobs.status === "ready" ? jobs.rows.filter(isFailed) : [];

  const reading =
    jobs.status === "ready" && jobs.rows.some((job) => job.detail.status === "loading");

  // The failed ones are known once every library's scan has been read.
  const shown: Paged<Job> =
    filter === "failed" && jobs.status === "ready"
      ? reading
        ? { status: "loading" }
        : { ...jobs, rows: failed }
      : jobs;

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
              {`Failed · ${failed.length}`}
            </Button>
          </div>
        }
      />
      <PagedList
        label="Jobs"
        list={shown}
        empty={
          filter === "failed"
            ? "No failed jobs."
            : "No library is shared with you, so there are no jobs."
        }
        rowKey={(job) => job.library.libraryId}
      >
        {row}
      </PagedList>
    </>
  );
}

function JobRow({ job }: { readonly job: Job }) {
  const platform = usePlatform();
  const actions = useActions<"cancel" | "retry">();
  const { library, detail } = job;

  if (detail.status === "loading") return null;

  if (detail.status === "error")
    return <Failed message={detail.error.message} retry={detail.retry} />;

  return (
    <JobRowView
      library={library}
      scan={detail.data.scan}
      running={actions.running}
      onCancel={(scan) =>
        void actions.run(
          "cancel",
          () => platform.core.libraries.cancelScan({ jobId: scan.jobId, attempt: scan.attempt }),
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

/** One library's scan, with Cancel while it runs and Retry after it failed. */
export function JobRowView({
  library,
  scan,
  running,
  onCancel,
  onRetry,
}: {
  readonly library: Library;
  readonly scan: Scan | null;
  readonly running: "cancel" | "retry" | null;
  readonly onCancel: (scan: Scan) => void;
  readonly onRetry: (libraryId: LibraryId) => void;
}) {
  const manages = library.level !== "view";
  const active = scan !== null && isActive(scan);

  const action = !manages ? null : active ? (
    <Button
      variant="raised"
      size="xs"
      disabled={running !== null || scan.canceling}
      onClick={() => onCancel(scan)}
    >
      {scan.canceling || running === "cancel" ? "Canceling…" : "Cancel"}
    </Button>
  ) : scan?.status === "failed" ? (
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
    <ItemRow title={library.name} facts={jobFacts(library, scan)} actions={action}>
      {scan?.error === null || scan?.error === undefined ? null : (
        <p className="font-mono text-caption/caption break-all text-danger">{scan.error}</p>
      )}
      {active && scan.message !== null ? (
        <p className="truncate font-mono text-caption/caption text-text-muted">{scan.message}</p>
      ) : null}
    </ItemRow>
  );
}
