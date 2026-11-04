import type { LibraryId } from "@media/contracts/ids";
import type {
  LibraryDetail,
  LibraryFile,
  LibraryFileFilter,
  LibraryFileSummary,
} from "@media/contracts/models/catalog";
import type { Job } from "@media/contracts/models/jobs";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { Chip } from "@media/ui/components/chip";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import { Skeleton } from "@media/ui/components/skeleton";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  CircleHelpIcon,
  RotateCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { artworkUrl } from "@/lib/artwork";
import { describeFailure, isFailure } from "@/lib/failure";
import { useNow } from "@/lib/use-now";

import { useAction } from "./action";
import {
  formatBytes,
  formatClock,
  formatCount,
  formatDate,
  formatDateTime,
  plural,
} from "./format";
import { LibraryDialog } from "./library-dialog";
import { fileName, qualityLabel, titleWithYear } from "./media-quality";
import { Notice } from "./notice";
import { PageHeader, crumbLinkClass } from "./page-header";
import { Poster } from "./poster";
import { isActive, isUnreachable, useLatestScans } from "./scan-jobs";
import { Cell, Column, StatusDot, Table, TableHead, TableRow } from "./table";

const PAGE_SIZE = 50;

const EMPTY_MESSAGES: Readonly<Record<LibraryFileFilter, string>> = {
  all: "No files yet.",
  missing: "No missing files.",
  unmatched: "Every title is matched.",
};

const FILTERS: ReadonlyArray<{ readonly id: LibraryFileFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "missing", label: "Missing" },
  { id: "unmatched", label: "Unmatched" },
];

/** Library detail: its files with quality, size and state, the problems to review, and scans. */
export function LibraryDetailScreen({ libraryId }: { readonly libraryId: LibraryId }) {
  const library = useCommandQuery("libraries.get", { libraryId });
  const summary = useCommandQuery("libraries.fileSummary", { libraryId });
  const job = useLatestScans().get(libraryId);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<LibraryFileFilter>("all");
  const now = useNow(30_000);

  if (library.status === "loading") return <Skeleton className="h-60 w-full rounded-control" />;

  if (library.status === "error") {
    return <LibraryLoadError error={library.error} onRetry={library.retry} />;
  }

  const detail = library.data;
  const counts = summary.status === "success" ? summary.data : null;
  const offline = job !== undefined && isUnreachable(job);

  const facts = [
    detail.roots.join(", "),
    plural(detail.titleCount, detail.kind === "shows" ? "show" : "title"),
  ].join(" · ");

  return (
    <>
      <PageHeader
        crumbs={[
          <Link key="libraries" to="/admin/libraries" className={crumbLinkClass}>
            Libraries
          </Link>,
        ]}
        title={detail.name}
        facts={facts}
        actions={
          <>
            <Button variant="raised" size="xs" onClick={() => setEditing(true)}>
              <SlidersHorizontalIcon strokeWidth={1.75} aria-hidden />
              Library settings
            </Button>
            {offline ? null : <ScanButton library={detail} job={job} />}
          </>
        }
      />
      {offline ? (
        <OfflineState library={detail} job={job} now={now} />
      ) : (
        <>
          {counts === null || counts.missingFiles === 0 ? null : (
            <MissingNotice
              counts={counts}
              reviewing={filter === "missing"}
              onReview={() => setFilter("missing")}
              now={now}
            />
          )}
          <FileList
            libraryId={libraryId}
            filter={filter}
            onFilterChange={setFilter}
            counts={counts}
            now={now}
          />
        </>
      )}
      <LibraryDialog open={editing} onOpenChange={setEditing} library={detail} />
    </>
  );
}

function LibraryLoadError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const gone = isFailure(error, "NotFound");

  return (
    <CalmState
      className="py-24"
      title={gone ? "This library is gone" : "This library didn't load"}
      description={gone ? undefined : describeFailure(error)}
      actions={
        <>
          {gone ? null : (
            <Button variant="raised" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Link to="/admin/libraries" className={buttonVariants({ variant: "raised", size: "sm" })}>
            Back to Libraries
          </Link>
        </>
      }
    />
  );
}

function MissingNotice({
  counts,
  reviewing,
  onReview,
  now,
}: {
  readonly counts: LibraryFileSummary;
  readonly reviewing: boolean;
  readonly onReview: () => void;
  readonly now: number;
}) {
  return (
    <Notice
      action={
        reviewing ? null : (
          <button
            type="button"
            onClick={onReview}
            className="shrink-0 cursor-pointer font-sans text-label/label font-semibold text-text hover:underline"
          >
            Review {formatCount(counts.missingFiles)} missing
          </button>
        )
      }
    >
      {counts.missingFiles === 1
        ? "1 file disappeared"
        : `${formatCount(counts.missingFiles)} files disappeared`}
      {counts.missingSince === null ? "." : ` since ${formatDate(counts.missingSince, now)}.`}
    </Notice>
  );
}

function ScanButton({
  library,
  job,
}: {
  readonly library: LibraryDetail;
  readonly job: Job | undefined;
}) {
  const scan = useCommand("libraries.scan");

  const action = useAction(() => scan({ libraryId: library.id, mode: "full" }), {
    success: () => `Scanning ${library.name}`,
  });

  return (
    <Button
      size="xs"
      className="font-semibold"
      disabled={action.pending || isActive(job)}
      onClick={() => void action.run()}
    >
      <RotateCwIcon strokeWidth={2} aria-hidden />
      {isActive(job) ? "Scanning…" : "Scan now"}
    </Button>
  );
}

function OfflineState({
  library,
  job,
  now,
}: {
  readonly library: LibraryDetail;
  readonly job: Job;
  readonly now: number;
}) {
  const scan = useCommand("libraries.scan");
  const [logOpen, setLogOpen] = useState(false);
  const retry = useAction(() => scan({ libraryId: library.id }));
  const since = job.finishedAt ?? job.createdAt;

  return (
    <div className="flex flex-col items-center gap-6 py-30 text-center">
      <div className="flex flex-col items-center gap-2.5">
        <span className="flex items-center gap-2 font-sans text-label/label font-semibold text-accent">
          <span aria-hidden className="size-2 rounded-pill bg-accent" />
          Offline since{" "}
          {now - since < 24 * 60 * 60 * 1000 ? formatClock(since) : formatDateTime(since, now)}
        </span>
        <h2 className="font-sans text-title/title font-bold tracking-display text-text">
          Can’t reach your NAS
        </h2>
        <p className="font-sans text-body/body text-text-muted">
          {library.titleCount === 0
            ? "Nothing in it is lost. It comes back when the share reconnects."
            : `Your ${plural(library.titleCount, library.kind === "shows" ? "show" : "title")} are safe and come back when the share reconnects.`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="dialog"
          className="px-5 text-label/label font-semibold"
          disabled={retry.pending}
          onClick={() => void retry.run()}
        >
          Retry now
        </Button>
        <Button
          variant="subtle"
          size="dialog"
          className="bg-surface-raised px-5 text-label/label"
          onClick={() => setLogOpen(true)}
        >
          View log
        </Button>
      </div>
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent title="Last scan">
          <DialogBody>
            <pre className="font-mono text-caption/caption whitespace-pre-wrap text-text-muted">
              {job.error}
            </pre>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="dialog" />}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const chipCount = (
  filter: LibraryFileFilter,
  counts: { readonly missingFiles: number; readonly unmatchedTitles: number } | null,
): string | null => {
  if (counts === null || filter === "all") return null;

  return formatCount(filter === "missing" ? counts.missingFiles : counts.unmatchedTitles);
};

function FileList({
  libraryId,
  filter,
  onFilterChange,
  counts,
  now,
}: {
  readonly libraryId: LibraryId;
  readonly filter: LibraryFileFilter;
  readonly onFilterChange: (filter: LibraryFileFilter) => void;
  readonly counts: { readonly missingFiles: number; readonly unmatchedTitles: number } | null;
  readonly now: number;
}) {
  const [paging, setPaging] = useState<{
    readonly filter: LibraryFileFilter;
    readonly cursors: ReadonlyArray<string>;
  }>({ filter, cursors: [] });

  const [search, setSearch] = useState("");
  const cursors = paging.filter === filter ? paging.cursors : [];

  const needle = search.trim().toLowerCase();

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Show" className="flex flex-wrap items-center gap-2">
          {FILTERS.map((each) => {
            const count = chipCount(each.id, counts);

            return (
              <Chip
                key={each.id}
                role="radio"
                aria-checked={each.id === filter}
                selected={each.id === filter}
                onClick={() => onFilterChange(each.id)}
                className="gap-2"
              >
                {each.label}
                {count === null ? null : <span>{count}</span>}
              </Chip>
            );
          })}
        </div>
        <label className="flex h-8 w-65 shrink-0 items-center gap-2 rounded-control border border-hairline bg-surface-raised px-2.5">
          <SearchIcon
            className="size-3.5 shrink-0 text-text-muted"
            strokeWidth={1.75}
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by title or filename"
            aria-label="Filter by title or filename"
            className="min-w-0 flex-1 bg-transparent font-sans text-label/label text-text outline-none placeholder:text-text-muted"
          />
        </label>
      </div>
      <Table label="Files">
        <TableHead>
          <Column className="min-w-80 flex-1">File</Column>
          <Column className="w-37">Quality</Column>
          <Column className="w-20">Size</Column>
          <Column className="w-50">Status</Column>
          <Column className="w-24" />
        </TableHead>
        {[null, ...cursors].map((cursor) => (
          <FilePage
            key={`${filter}:${cursor ?? "first"}`}
            libraryId={libraryId}
            filter={filter}
            cursor={cursor}
            needle={needle}
            now={now}
            onMore={(next) =>
              setPaging({
                filter,
                cursors: cursors.includes(next) ? cursors : [...cursors, next],
              })
            }
            last={cursor === (cursors.at(-1) ?? null)}
          />
        ))}
      </Table>
    </>
  );
}

const matches = (file: LibraryFile, needle: string): boolean =>
  needle.length === 0 ||
  file.title.name.toLowerCase().includes(needle) ||
  file.path.toLowerCase().includes(needle);

function FilePage({
  libraryId,
  filter,
  cursor,
  needle,
  now,
  last,
  onMore,
}: {
  readonly libraryId: LibraryId;
  readonly filter: LibraryFileFilter;
  readonly cursor: string | null;
  readonly needle: string;
  readonly now: number;
  readonly last: boolean;
  readonly onMore: (cursor: string) => void;
}) {
  const page = useCommandQuery("libraries.files", { libraryId, filter, cursor, limit: PAGE_SIZE });

  if (page.status === "loading") return <Skeleton className="mx-3 h-13 rounded-control" />;

  if (page.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3 px-3 py-4">
        <p className="font-sans text-body/body text-text-muted">{describeFailure(page.error)}</p>
        <Button variant="raised" size="xs" onClick={page.retry}>
          Try again
        </Button>
      </div>
    );
  }

  const shown = page.data.items.filter((file) => matches(file, needle));
  const next = page.data.nextCursor;

  return (
    <>
      {shown.map((file) => (
        <FileRow key={file.id} file={file} libraryId={libraryId} now={now} />
      ))}
      {cursor === null && page.data.items.length === 0 ? (
        <p className="px-3 py-4 font-sans text-body/body text-text-muted">
          {EMPTY_MESSAGES[filter]}
        </p>
      ) : null}
      {last && next !== null ? (
        <div className="px-3 pt-3">
          <Button variant="raised" size="xs" onClick={() => onMore(next)}>
            Show more
          </Button>
        </div>
      ) : null}
    </>
  );
}

const episodeLabel = (file: LibraryFile): string =>
  file.episode === null
    ? titleWithYear(file.title)
    : `${file.title.name} · S${file.episode.seasonNumber} E${file.episode.episodeNumber}`;

function FileStatus({ file, now }: { readonly file: LibraryFile; readonly now: number }) {
  if (file.missing) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 font-sans text-label/label font-medium text-warning">
          <TriangleAlertIcon className="size-3" strokeWidth={2} aria-hidden />
          Missing
        </span>
        {file.missingSince === null ? null : (
          <span className="font-mono text-caption/caption text-text-muted">
            since {formatDateTime(file.missingSince, now)}
          </span>
        )}
      </div>
    );
  }

  if (file.title.matchStatus === "unmatched") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 font-sans text-label/label font-medium text-text">
          <CircleHelpIcon className="size-3" strokeWidth={2} aria-hidden />
          Unmatched
        </span>
        <span className="truncate font-mono text-caption/caption text-text-muted">
          best guess · {episodeLabel(file)}
        </span>
      </div>
    );
  }

  return (
    <span className="flex items-center gap-1.5 font-sans text-label/label text-text">
      <StatusDot tone="success" />
      {file.title.matchStatus === "manual" ? "Matched by hand" : "Matched"}
    </span>
  );
}

function FileRow({
  file,
  libraryId,
  now,
}: {
  readonly file: LibraryFile;
  readonly libraryId: LibraryId;
  readonly now: number;
}) {
  const unmatched = file.title.matchStatus === "unmatched";

  const match = {
    to: "/admin/libraries/$libraryId/match/$titleId",
    params: { libraryId, titleId: file.title.id },
  } as const;

  return (
    <TableRow className="h-13">
      <Cell className="flex min-w-80 flex-1 items-center gap-3">
        {unmatched ? (
          <span
            aria-hidden
            className={cn(
              "h-9 w-6 shrink-0 rounded-bar border border-dashed border-text-muted",
              file.missing && "opacity-50",
            )}
          />
        ) : (
          <Poster
            src={artworkUrl(file.title.poster, "thumb")}
            alt=""
            className={cn("h-9 w-6 rounded-bar", file.missing && "opacity-50")}
          />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          {unmatched ? (
            <span className="truncate font-sans text-label/label font-semibold text-text-muted italic">
              No match
            </span>
          ) : (
            <Link
              {...match}
              className="truncate font-sans text-label/label font-semibold text-text hover:underline"
            >
              {episodeLabel(file)}
            </Link>
          )}
          <span
            className="truncate font-mono text-caption/caption text-text-muted"
            title={file.path}
          >
            {fileName(file.path)}
          </span>
        </span>
      </Cell>
      <Cell className="w-37 font-mono text-caption/caption text-text-muted">
        {qualityLabel(file.video)}
      </Cell>
      <Cell className="w-20 font-mono text-caption/caption text-text-muted">
        {formatBytes(file.sizeBytes)}
      </Cell>
      <Cell className="w-50">
        <FileStatus file={file} now={now} />
      </Cell>
      <Cell className="flex w-24 justify-end">
        {file.missing || !unmatched ? null : (
          <Link {...match} className={buttonVariants({ variant: "raised", size: "row" })}>
            Fix match
          </Link>
        )}
      </Cell>
    </TableRow>
  );
}
