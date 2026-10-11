import type { Job, JobStatus } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { Segmented } from "@music/ui/components/segmented";
import { Skeleton } from "@music/ui/components/skeleton";
import { cn } from "@music/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ProgressBar, jobPercent } from "@/components/auth/scan-progress";
import { SettingsHeader, TerminalHint } from "@/components/settings/settings-ui";
import { useAction } from "@/lib/action";
import { formatAgo, formatCount } from "@/lib/format";

export const Route = createFileRoute("/_app/settings/jobs")({ component: JobsSettings });

const STATUS: Readonly<Record<JobStatus, { readonly label: string; readonly dot: string }>> = {
  pending: { label: "Waiting", dot: "bg-accent" },
  running: { label: "Running", dot: "bg-accent" },
  done: { label: "Finished", dot: "bg-success" },
  failed: { label: "Failed", dot: "bg-danger" },
  cancelled: { label: "Cancelled", dot: "bg-border" },
};

function JobsSettings() {
  const jobs = useRead("jobs.list", {});
  const me = useRead("account.me", {});
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const failed = (jobs ?? []).filter((job) => job.status === "failed");
  const shown = filter === "failed" ? failed : (jobs ?? []);

  return (
    <div className="flex flex-col gap-6">
      <SettingsHeader
        title="Jobs"
        lead="Everything that touches files: scans now, file moves later. Progress updates live."
        action={
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "failed", label: `Failed · ${formatCount(failed.length)}` },
            ]}
          />
        }
      />
      {jobs === undefined ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : shown.length === 0 ? (
        <p className="py-4 font-sans text-md/md text-text-muted">
          {filter === "failed"
            ? "No failed jobs."
            : "No jobs yet. Scans show up here while they run."}
        </p>
      ) : (
        <div role="list" aria-label="Jobs" className="flex flex-col">
          {shown.map((job) => (
            <JobRow key={job.id} job={job} admin={me?.role === "admin"} />
          ))}
        </div>
      )}
      <TerminalHint label="From a terminal" command="music jobs list · music jobs cancel --help" />
    </div>
  );
}

function JobRow({ job, admin }: { readonly job: Job; readonly admin: boolean }) {
  const cancel = useRun("jobs.cancel");
  const rescan = useRun("libraries.scan");
  const active = job.status === "running" || job.status === "pending";
  const percent = jobPercent(job);
  const status = STATUS[job.status];

  const [stop, stopping] = useAction(() => cancel({ jobId: job.id }), {
    success: () => "Cancelled the job",
  });

  const [retry, retrying] = useAction(
    async () => {
      if (job.libraryId !== null) await rescan({ libraryId: job.libraryId });
    },
    { success: () => "Started the scan again" },
  );

  const when = job.finishedAt ?? job.startedAt ?? job.createdAt;

  return (
    <div
      role="listitem"
      className={cn(
        "flex gap-4 border-b border-border px-3 py-4",
        job.error === null ? "items-center" : "items-start",
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", status.dot, job.error !== null && "mt-1.5")}
      />
      <div className="flex min-w-0 grow flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <span
            className={cn(
              "font-sans text-base/sm text-text",
              active || job.status === "failed" ? "font-medium" : "text-text-muted",
            )}
          >
            {job.label}
          </span>
          <span className="font-sans text-sm/xs text-text-muted">{status.label}</span>
        </div>
        {active && percent !== null ? (
          <ProgressBar
            percent={percent}
            className="h-[3px] w-full max-w-[420px]"
            label={job.label}
          />
        ) : null}
        {job.error === null ? null : (
          <span className="font-mono text-xs/xs break-all text-danger">{job.error}</span>
        )}
        {job.message !== null && active ? (
          <span className="truncate font-mono text-xs/xs text-text-muted">{job.message}</span>
        ) : null}
      </div>
      <span className="w-[120px] shrink-0 font-mono text-xs/xs text-text-muted">
        {active && job.total !== null
          ? `${formatCount(job.done)} / ${formatCount(job.total)}`
          : formatAgo(when)}
      </span>
      <span className="flex w-[80px] shrink-0 justify-end">
        {admin && active ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => void stop()}
            className="font-sans text-sm/xs font-medium text-text hover:underline disabled:opacity-(--opacity-muted)"
          >
            {stopping ? "Cancelling…" : "Cancel"}
          </button>
        ) : admin && job.status === "failed" && job.libraryId !== null ? (
          <button
            type="button"
            disabled={retrying}
            onClick={() => void retry()}
            className="font-sans text-sm/xs font-medium text-text hover:underline disabled:opacity-(--opacity-muted)"
          >
            {retrying ? "Starting…" : "Retry"}
          </button>
        ) : null}
      </span>
    </div>
  );
}
