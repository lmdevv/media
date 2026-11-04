import type { LibraryDetail } from "@media/contracts/models/catalog";
import type { Job } from "@media/contracts/models/jobs";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { ProgressBar } from "@media/ui/components/progress-bar";
import { Skeleton } from "@media/ui/components/skeleton";
import { Spinner } from "@media/ui/components/spinner";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { PlusIcon, RotateCwIcon } from "lucide-react";

import { useNow } from "@/lib/use-now";

import { useAction } from "./action";
import { KIND_LABELS, formatAgo, formatCount, formatPercent, formatSpan, plural } from "./format";
import { LibraryDialog } from "./library-dialog";
import { PageHeader } from "./page-header";
import { isActive, useLatestScans } from "./scan-jobs";
import { Cell, Column, StatusDot, Table, TableHead } from "./table";
import { QueryView } from "./query-view";

/** Libraries and scans: every library with its folders, size, last scan, and live scan progress. */
export function LibrariesScreen({
  adding,
  onAddingChange: setAdding,
}: {
  /** Whether Add library is open; it lives in the URL so the command menu can open it. */
  readonly adding: boolean;
  readonly onAddingChange: (open: boolean) => void;
}) {
  const libraries = useCommandQuery("libraries.listDetails", {});
  const scans = useLatestScans();
  const scan = useCommand("libraries.scan");
  const now = useNow(10_000);
  const list = libraries.status === "success" ? libraries.data : [];

  const scanAll = useAction(
    async () => {
      const idle = list.filter((library) => !isActive(scans.get(library.id)));

      await Promise.all(idle.map((library) => scan({ libraryId: library.id })));

      return idle.length;
    },
    {
      success: (count) =>
        count === 0
          ? "Every library is already scanning"
          : `Scanning ${formatCount(count)} ${count === 1 ? "library" : "libraries"}`,
    },
  );

  return (
    <>
      <PageHeader
        title="Libraries"
        actions={
          <>
            <Button
              variant="raised"
              size="xs"
              disabled={scanAll.pending || list.length === 0}
              onClick={() => void scanAll.run()}
            >
              <RotateCwIcon strokeWidth={1.75} aria-hidden />
              Scan all
            </Button>
            <Button size="xs" className="font-semibold" onClick={() => setAdding(true)}>
              <PlusIcon strokeWidth={2} aria-hidden />
              Add library
            </Button>
          </>
        }
      />
      <QueryView query={libraries} loading={<Skeleton className="h-36 w-full rounded-control" />}>
        {(_details) => (
          <Table label="Libraries">
            <TableHead>
              <Column className="w-40">Name</Column>
              <Column className="w-20">Type</Column>
              <Column className="min-w-50 flex-1">Path</Column>
              <Column className="w-37">Items</Column>
              <Column className="w-30">Last scan</Column>
              <Column className="w-25">Status</Column>
              <Column className="w-22" />
            </TableHead>
            {list.map((library) => (
              <LibraryRow
                key={library.id}
                library={library}
                job={scans.get(library.id)}
                now={now}
              />
            ))}
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-11 shrink-0 cursor-pointer items-center gap-2.5 px-3 text-left font-sans text-label/label font-medium text-text-muted transition-colors hover:text-text"
            >
              <span className="flex h-7 w-5 shrink-0 items-center justify-center rounded-bar border border-dashed border-text-muted">
                <PlusIcon className="size-3" strokeWidth={2} aria-hidden />
              </span>
              Add a folder
            </button>
          </Table>
        )}
      </QueryView>
      <LibraryDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

const lastScanLabel = (library: LibraryDetail, job: Job | undefined, now: number): string => {
  if (job?.status === "running" && job.startedAt !== null) {
    return `running ${formatSpan(now - job.startedAt)}`;
  }

  if (job?.status === "pending") return "queued";

  return library.lastScanAt === null ? "never" : formatAgo(library.lastScanAt, now);
};

function ScanStatus({ job }: { readonly job: Job | undefined }) {
  if (job !== undefined && isActive(job)) {
    return (
      <>
        <Spinner className="size-3 text-text" />
        <span className="font-sans text-label/label text-text">
          {job.status === "pending" ? "Queued" : "Scanning"}
        </span>
      </>
    );
  }

  if (job?.status === "failed") {
    return (
      <>
        <StatusDot tone="danger" />
        <span className="font-sans text-label/label text-danger">Failed</span>
      </>
    );
  }

  return (
    <>
      <StatusDot tone="success" />
      <span className="font-sans text-label/label text-text">Ready</span>
    </>
  );
}

function LibraryRow({
  library,
  job,
  now,
}: {
  readonly library: LibraryDetail;
  readonly job: Job | undefined;
  readonly now: number;
}) {
  const scan = useCommand("libraries.scan");
  const cancel = useCommand("jobs.cancel");
  const active = isActive(job);
  const startScan = useAction(() => scan({ libraryId: library.id }));
  const stopScan = useAction((target: Job) => cancel({ jobId: target.id }));
  const progress = job?.status === "running" ? job.progress : null;

  return (
    <div
      role="rowgroup"
      className={cn("flex flex-col rounded-control", active && "bg-surface-raised/55")}
    >
      <div role="row" className="flex h-11 shrink-0 items-center gap-3 px-3">
        <Cell className="flex w-40 items-center gap-2.5">
          <span aria-hidden className="h-7 w-5 shrink-0 rounded-bar bg-text/10" />
          <Link
            to="/admin/libraries/$libraryId"
            params={{ libraryId: library.id }}
            className="truncate font-sans text-label/label font-semibold text-text hover:underline"
          >
            {library.name}
          </Link>
        </Cell>
        <Cell className="w-20 font-sans text-label/label text-text-muted">
          {KIND_LABELS[library.kind]}
        </Cell>
        <Cell className="min-w-50 flex-1 truncate font-mono text-caption/caption text-text-muted">
          {library.roots.join(", ")}
        </Cell>
        <Cell className="w-37 font-mono text-caption/caption text-text">
          {plural(library.titleCount, "title")}
        </Cell>
        <Cell className="w-30 font-mono text-caption/caption text-text-muted">
          {lastScanLabel(library, job, now)}
        </Cell>
        <Cell className="flex w-25 items-center gap-1.5">
          <ScanStatus job={job} />
        </Cell>
        <Cell className="flex w-22 justify-end">
          {active && job !== undefined ? (
            <button
              type="button"
              disabled={stopScan.pending}
              onClick={() => void stopScan.run(job)}
              className="cursor-pointer font-sans text-label/label font-semibold text-text-muted hover:text-text"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              disabled={startScan.pending}
              onClick={() => void startScan.run()}
              aria-label={`Scan ${library.name} now`}
              className="cursor-pointer font-sans text-label/label font-semibold whitespace-nowrap text-text hover:text-accent"
            >
              Scan now
            </button>
          )}
        </Cell>
      </div>
      {progress === null ? null : (
        <div className="flex flex-col gap-2 pr-3 pb-3.5 pl-10.5">
          <div className="flex items-center gap-3">
            <ProgressBar
              tone="surface"
              value={
                progress.total === null || progress.total === 0 ? 0 : progress.done / progress.total
              }
              label={`${library.name} scan progress`}
              className="flex-1 rounded-pill bg-hairline [&>div]:rounded-pill"
            />
            <span className="w-55 shrink-0 text-right font-mono text-caption/caption text-text">
              {progress.total === null
                ? `${formatCount(progress.done)} files`
                : `${formatCount(progress.done)} / ${formatCount(progress.total)} files · ${formatPercent(progress.total === 0 ? 0 : progress.done / progress.total)}`}
            </span>
          </div>
          {progress.message === null ? null : (
            <span className="truncate font-mono text-caption/caption text-text-muted">
              {progress.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
