import { JobId, LibraryId } from "@media/contracts/ids";
import type { Job } from "@media/contracts/models/jobs";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { Skeleton } from "@media/ui/components/skeleton";
import { cn } from "@media/ui/lib/utils";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, CircleAlertIcon, RotateCwIcon } from "lucide-react";
import { Schema } from "effect";
import { useState } from "react";

import { AuthPage, PageTitle, SetupSteps } from "@/components/auth/auth-page";
import { artworkUrl } from "@/lib/artwork";
import { toastFailure } from "@/lib/failure";
import { formatCount } from "@/lib/format";
import { isStopped, scanProgress } from "@/lib/scan-progress";
import { useNow } from "@/lib/use-now";
import { RequireSignedIn } from "@/session/guards";
import { BlankPage } from "@/session/redirect";

const ScanSearch = Schema.Struct({ jobId: JobId, libraryId: LibraryId });

export const Route = createFileRoute("/setup/scan")({
  validateSearch: Schema.toStandardSchemaV1(ScanSearch),
  head: () => ({ meta: [{ title: "First scan · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <FirstScanPage />
    </RequireSignedIn>
  ),
});

const POSTER_SLOTS = 6;

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

function FirstScanPage() {
  const { jobId, libraryId } = Route.useSearch();
  const job = useCommandQuery("jobs.get", { jobId });
  const library = useCommandQuery("libraries.get", { libraryId });

  if (job.status === "loading" || library.status === "loading") return <BlankPage />;

  if (job.status === "error") {
    return (
      <AuthPage width="dialog">
        <PageTitle>This scan is gone.</PageTitle>
        <Link to="/" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
          Continue to [movies]
          <ArrowRightIcon strokeWidth={2} aria-hidden />
        </Link>
      </AuthPage>
    );
  }

  return (
    <ScanView
      job={job.data}
      libraryId={libraryId}
      folder={library.status === "success" ? (library.data.roots[0] ?? null) : null}
      titleCount={library.status === "success" ? library.data.titleCount : 0}
    />
  );
}

function ScanView({
  job,
  libraryId,
  folder,
  titleCount,
}: {
  readonly job: Job;
  readonly libraryId: LibraryId;
  readonly folder: string | null;
  readonly titleCount: number;
}) {
  const now = useNow(5000);
  const navigate = useNavigate();
  const rescan = useCommand("libraries.scan");
  const [retrying, setRetrying] = useState(false);
  const progress = scanProgress(job, now);
  const stopped = isStopped(job);
  const percent = Math.round((progress.fraction ?? 0) * 100);

  const retry = async (): Promise<void> => {
    setRetrying(true);

    try {
      const queued = await rescan({ libraryId });

      await navigate({
        to: "/setup/scan",
        search: { jobId: queued.jobId, libraryId },
        replace: true,
      });
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <AuthPage width="dialog">
      <div className="flex flex-col gap-3">
        <SetupSteps step={3} label="First scan" />
        <PageTitle>{stopped ? "The scan stopped." : "Building your library."}</PageTitle>
        {stopped || folder === null ? null : (
          <p className="text-body/body text-text-muted">Scanning {folder}</p>
        )}
      </div>
      <div className="flex flex-col gap-8">
        <ScanMeter
          percent={percent}
          status={scanStatus(job, stopped, progress.minutesLeft)}
          stopped={stopped}
        />
        <dl className="flex">
          <Stat label="Files found" value={progress.total ?? progress.done} />
          <Stat label="Scanned" value={progress.done} />
          <Stat label="Titles" value={titleCount} />
          {stopped ? <Stat label="Error" value={1} /> : <span className="grow basis-0" />}
        </dl>
        {stopped ? <ScanFailure job={job} /> : <JustMatched libraryId={libraryId} />}
      </div>
      {stopped ? (
        <StoppedActions retrying={retrying} onRetry={() => void retry()} titleCount={titleCount} />
      ) : (
        <Link to="/" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
          Continue to [movies]
          <ArrowRightIcon strokeWidth={2} aria-hidden />
        </Link>
      )}
    </AuthPage>
  );
}

const scanStatus = (job: Job, stopped: boolean, minutesLeft: number | null): string | null => {
  if (stopped)
    return job.finishedAt === null ? "stopped" : `stopped ${clock.format(job.finishedAt)}`;

  if (job.status === "succeeded") return "done";

  if (job.status === "pending") return "waiting for the media service";

  return minutesLeft === null ? null : `~${minutesLeft} min left`;
};

function ScanMeter({
  percent,
  status,
  stopped,
}: {
  readonly percent: number;
  readonly status: string | null;
  readonly stopped: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between">
        <p
          aria-live="polite"
          className={cn(
            "text-display/display font-heavy tracking-display tabular-nums",
            stopped ? "text-text-muted" : "text-text",
          )}
        >
          {percent}%
        </p>
        {status === null ? null : (
          <p className="pb-1.5 font-mono text-label/label text-text">{status}</p>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Scan progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="flex h-1 overflow-hidden rounded-pill bg-hairline"
      >
        <div
          className={cn("h-1 rounded-pill", stopped ? "bg-text-muted" : "bg-accent")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function ScanFailure({ job }: { readonly job: Job }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-control bg-accent/10 p-3.5">
      <CircleAlertIcon className="size-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
      <div className="flex grow basis-0 flex-col gap-1">
        <p className="text-label/label font-semibold text-text">
          {job.status === "cancelled" ? "The scan was cancelled" : "The scan hit an error"}
        </p>
        {job.error === null ? null : (
          <p className="text-label/label break-words text-text-muted">{job.error}</p>
        )}
      </div>
    </div>
  );
}

function StoppedActions({
  retrying,
  onRetry,
  titleCount,
}: {
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly titleCount: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Button size="lg" className="w-full" disabled={retrying} onClick={onRetry}>
        <RotateCwIcon strokeWidth={2} aria-hidden />
        Retry scan
      </Button>
      <Link
        to="/"
        className="self-center text-label/caption font-medium text-text-muted underline decoration-1 underline-offset-2 hover:text-text"
      >
        Continue with {formatCount(titleCount)} {titleCount === 1 ? "title" : "titles"} for now
      </Link>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="flex grow basis-0 flex-col-reverse gap-1 py-4">
      <dt className="text-caption/caption text-text-muted">{label}</dt>
      <dd className="font-mono text-heading/heading text-text tabular-nums">
        {formatCount(value)}
      </dd>
    </div>
  );
}

function JustMatched({ libraryId }: { readonly libraryId: LibraryId }) {
  const profiles = useCommandQuery("profiles.list", {});
  const profile = profiles.status === "success" ? profiles.data.find((p) => !p.locked) : undefined;

  const titles = useCommandQuery(
    "titles.list",
    profile === undefined
      ? "skip"
      : { profileId: profile.id, libraryId, sort: "added", limit: POSTER_SLOTS },
  );

  const items = titles.status === "success" ? titles.data.items : [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption/caption font-medium tracking-caps text-text-muted uppercase">
        Just matched
      </p>
      <div className="flex gap-2">
        {Array.from({ length: POSTER_SLOTS }, (_, index) => {
          const title = items[index];

          const poster =
            title === undefined ? undefined : artworkUrl(title.artwork.poster, "thumb");

          return title === undefined ? (
            <Skeleton
              key={index}
              className={cn(
                "h-30 grow basis-0 animate-none rounded-poster border border-hairline bg-surface-raised",
                index === POSTER_SLOTS - 1 && "opacity-50",
              )}
            />
          ) : (
            <div
              key={title.id}
              role="img"
              aria-label={title.name}
              className="h-30 grow basis-0 rounded-poster bg-surface-raised bg-cover bg-center"
              style={poster === undefined ? undefined : { backgroundImage: `url("${poster}")` }}
            />
          );
        })}
      </div>
    </div>
  );
}
