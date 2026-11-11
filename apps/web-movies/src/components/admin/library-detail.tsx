import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { Chip } from "@media/ui/components/chip";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import { PageHeader, crumbLinkClass } from "@media/ui/components/page-header";
import { Skeleton } from "@media/ui/components/skeleton";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { describeFailure, isFailure } from "@media/ui/lib/failure";
import { usePages } from "@media/ui/lib/pages";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { CircleHelpIcon, RotateCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { artworkUrl } from "@/lib/artwork";
import { useNow } from "@media/ui/lib/use-now";
import { useMe } from "@/session/session";

import { useAction } from "./action";
import {
  formatBytes,
  formatClock,
  formatCount,
  formatDate,
  formatDateTime,
  plural,
} from "./format";
import { accountLibraryHref } from "./libraries";
import { fileName, qualityLabel, titleWithYear } from "./media-quality";
import { Notice } from "./notice";
import { PagedView, ShowMore } from "./paged-view";
import { Poster } from "./poster";
import type { LibraryId } from "./route-params";
import { isActive, isUnreachable } from "./scan";
import { allows } from "./scope-gate";
import { Cell, Column, StatusDot, Table, TableHead, TableRow } from "./table";
import type {
  LibraryDetail,
  LibraryFile,
  LibraryFileFilter,
  LibraryFileSummary,
  Scan,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A library's page: its scan, its files with their quality, size, and state, and the missing
 * files to review.
 */
export function LibraryDetailScreen({ libraryId }: { readonly libraryId: LibraryId }) {
  const platform = usePlatform();
  const library = usePlatformQuery(platform.core.libraries.get, { libraryId });
  const summary = usePlatformQuery(platform.movies.files.summary, { libraryId });
  const [filter, setFilter] = useState<LibraryFileFilter>("all");
  const me = useMe();
  const now = useNow(30_000);

  if (library.status === "loading") return <Skeleton className="h-60 w-full rounded-control" />;

  if (library.status === "error") {
    return <LibraryLoadError error={library.error} onRetry={library.retry} />;
  }

  const detail = library.data;
  const offline = isUnreachable(detail.scan);
  const counts = summary.status === "success" ? summary.data : null;

  const facts = [
    detail.folders === null ? null : detail.folders.join(", "),
    detail.items === null ? null : plural(detail.items, "title"),
  ]
    .filter((fact) => fact !== null)
    .join(" · ");

  return (
    <>
      <PageHeader
        crumbs={[
          <Link key="libraries" to="/admin/libraries" className={crumbLinkClass}>
            Libraries
          </Link>,
        ]}
        title={detail.name}
        facts={facts === "" ? undefined : facts}
        actions={
          <>
            {me !== null && allows(me, "admin") ? (
              <a
                href={accountLibraryHref(detail.libraryId)}
                className={buttonVariants({ variant: "raised", size: "xs" })}
              >
                Manage in account
              </a>
            ) : null}
            {offline ? null : <ScanButton library={detail} />}
          </>
        }
      />
      {isUnreachable(detail.scan) ? (
        <OfflineState library={detail} scan={detail.scan} now={now} />
      ) : (
        <>
          {counts === null || counts.missing === null || counts.missing === 0 ? null : (
            <MissingNotice
              missing={counts.missing}
              missingSince={counts.missingSince}
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
  const gone = isFailure(error, "NotFound") || isFailure(error, "InvalidArgs");

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

function ScanButton({ library }: { readonly library: LibraryDetail }) {
  const platform = usePlatform();
  const active = isActive(library.scan);

  const action = useAction(
    () => platform.core.libraries.scan({ libraryId: library.libraryId, mode: "full" }),
    {
      success: () => `Scanning ${library.name}`,
    },
  );

  return (
    <Button
      size="xs"
      className="font-semibold"
      disabled={action.pending || active}
      onClick={() => void action.run()}
    >
      <RotateCwIcon strokeWidth={2} aria-hidden />
      {active ? "Scanning…" : "Scan now"}
    </Button>
  );
}

function OfflineState({
  library,
  scan,
  now,
}: {
  readonly library: LibraryDetail;
  readonly scan: Scan;
  readonly now: number;
}) {
  const platform = usePlatform();
  const [logOpen, setLogOpen] = useState(false);
  const retry = useAction(() => platform.core.libraries.scan({ libraryId: library.libraryId }));
  const since = scan.finishedAt;

  return (
    <div className="flex flex-col items-center gap-6 py-30 text-center">
      <div className="flex flex-col items-center gap-2.5">
        {since === null ? null : (
          <span className="flex items-center gap-2 font-sans text-label/label font-semibold text-accent">
            <span aria-hidden className="size-2 rounded-pill bg-accent" />
            Offline since {now - since < DAY_MS ? formatClock(since) : formatDateTime(since, now)}
          </span>
        )}
        <h2 className="font-sans text-title/title font-bold tracking-display text-text">
          Can’t reach your NAS
        </h2>
        <p className="font-sans text-body/body text-text-muted">
          {library.items === null || library.items === 0
            ? "Nothing in it is lost. It comes back when the share reconnects."
            : `Your ${plural(library.items, "title")} are safe and come back when the share reconnects.`}
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
              {scan.error}
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

function MissingNotice({
  missing,
  missingSince,
  reviewing,
  onReview,
  now,
}: {
  readonly missing: number;
  readonly missingSince: number | null;
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
            Review {formatCount(missing)} missing
          </button>
        )
      }
    >
      {missing === 1 ? "1 file disappeared" : `${formatCount(missing)} files disappeared`}
      {missingSince === null ? "." : ` since ${formatDate(missingSince, now)}.`}
    </Notice>
  );
}

const chipCount = (filter: LibraryFileFilter, counts: LibraryFileSummary | null): string | null => {
  if (counts === null || filter === "all") return null;

  const count = filter === "missing" ? counts.missing : counts.unmatched;

  return count === null ? null : formatCount(count);
};

const matches = (file: LibraryFile, needle: string): boolean =>
  needle.length === 0 ||
  file.title.name.toLowerCase().includes(needle) ||
  file.path.toLowerCase().includes(needle);

/** The title or filename filter searches only the pages loaded so far. */
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
  readonly counts: LibraryFileSummary | null;
  readonly now: number;
}) {
  const platform = usePlatform();
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();

  const files = usePages(platform.movies.files.list, (paginationOpts) => ({
    paginationOpts,
    libraryId,
    filter,
  }));

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
      <PagedView list={files} loading={<Skeleton className="h-13 w-full rounded-control" />}>
        {({ rows, next }) => (
          <Table label="Files">
            <TableHead>
              <Column className="min-w-80 flex-1">File</Column>
              <Column className="w-37">Quality</Column>
              <Column className="w-20">Size</Column>
              <Column className="w-50">Status</Column>
              <Column className="w-24" />
            </TableHead>
            {rows
              .filter((file) => matches(file, needle))
              .map((file) => (
                <FileRow key={file.id} file={file} libraryId={libraryId} now={now} />
              ))}
            {rows.length === 0 && next.kind === "done" ? (
              <p className="px-3 py-4 font-sans text-body/body text-text-muted">
                {EMPTY_MESSAGES[filter]}
              </p>
            ) : null}
            <div className="px-3 pt-3 empty:hidden">
              <ShowMore next={next} />
            </div>
          </Table>
        )}
      </PagedView>
    </>
  );
}

const episodeLabel = (file: LibraryFile): string =>
  file.episode === null
    ? titleWithYear(file.title)
    : `${file.title.name} · S${file.episode.seasonNumber} E${file.episode.episodeNumber}`;

const fileLabel = (file: LibraryFile): string =>
  file.version.versionName === null
    ? episodeLabel(file)
    : `${episodeLabel(file)} · ${file.version.versionName}`;

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
              {fileLabel(file)}
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
        {qualityLabel(file.version)}
      </Cell>
      <Cell className="w-20 font-mono text-caption/caption text-text-muted">
        {formatBytes(file.version.sizeBytes)}
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
