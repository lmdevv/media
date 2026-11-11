import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
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
import { RotateCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { artworkUrl } from "@/lib/artwork";
import { useNow } from "@media/ui/lib/use-now";
import { useMe } from "@/session/session";

import { useAction } from "./action";
import { formatClock, formatDateTime, plural } from "./format";
import { accountLibraryHref } from "./libraries";
import { titleWithYear } from "./media-quality";
import { PagedView, ShowMore } from "./paged-view";
import { Poster } from "./poster";
import type { LibraryId } from "./route-params";
import { isActive, isUnreachable } from "./scan";
import { allows } from "./scope-gate";
import { Cell, Column, Table, TableHead, TableRow } from "./table";
import type { LibraryDetail, Scan, TitleCard } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A library's page: its scan, and its titles, each linking to its match. */
export function LibraryDetailScreen({ libraryId }: { readonly libraryId: LibraryId }) {
  const platform = usePlatform();
  const library = usePlatformQuery(platform.core.libraries.get, { libraryId });
  const me = useMe();
  const now = useNow(30_000);

  if (library.status === "loading") return <Skeleton className="h-60 w-full rounded-control" />;

  if (library.status === "error") {
    return <LibraryLoadError error={library.error} onRetry={library.retry} />;
  }

  const detail = library.data;
  const offline = isUnreachable(detail.scan);

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
        <TitleList libraryId={libraryId} />
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

const matches = (title: TitleCard, needle: string): boolean =>
  needle.length === 0 || title.name.toLowerCase().includes(needle);

/** The library's titles by name, a page at a time, filtered by name over the pages loaded. */
function TitleList({ libraryId }: { readonly libraryId: LibraryId }) {
  const platform = usePlatform();
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();

  const titles = usePages(platform.movies.titles.list, (paginationOpts) => ({
    paginationOpts,
    libraryId,
    sort: "name" as const,
  }));

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-3">
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
            placeholder="Filter by title"
            aria-label="Filter by title"
            className="min-w-0 flex-1 bg-transparent font-sans text-label/label text-text outline-none placeholder:text-text-muted"
          />
        </label>
      </div>
      <PagedView list={titles} loading={<Skeleton className="h-13 w-full rounded-control" />}>
        {({ rows, next }) => (
          <Table label="Titles">
            <TableHead>
              <Column className="min-w-80 flex-1">Title</Column>
              <Column className="w-20">Kind</Column>
              <Column className="w-30">Status</Column>
              <Column className="w-24" />
            </TableHead>
            {rows
              .filter((title) => matches(title, needle))
              .map((title) => (
                <TitleRow key={title.id} title={title} libraryId={libraryId} />
              ))}
            {rows.length === 0 && next.kind === "done" ? (
              <p className="px-3 py-4 font-sans text-body/body text-text-muted">No titles yet.</p>
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

function TitleRow({
  title,
  libraryId,
}: {
  readonly title: TitleCard;
  readonly libraryId: LibraryId;
}) {
  const match = {
    to: "/admin/libraries/$libraryId/match/$titleId",
    params: { libraryId, titleId: title.id },
  } as const;

  return (
    <TableRow className="h-13">
      <Cell className="flex min-w-80 flex-1 items-center gap-3">
        <Poster
          src={artworkUrl(title.artwork.poster, "thumb")}
          alt=""
          className={cn("h-9 w-6 rounded-bar", !title.available && "opacity-50")}
        />
        <Link
          {...match}
          className="truncate font-sans text-label/label font-semibold text-text hover:underline"
        >
          {titleWithYear(title)}
        </Link>
      </Cell>
      <Cell className="w-20 font-sans text-label/label text-text-muted">
        {title.kind === "show" ? "Series" : "Film"}
      </Cell>
      <Cell className="w-30">
        {title.available ? null : (
          <span className="flex items-center gap-1.5 font-sans text-label/label font-medium text-warning">
            <TriangleAlertIcon className="size-3" strokeWidth={2} aria-hidden />
            Missing
          </span>
        )}
      </Cell>
      <Cell className="flex w-24 justify-end">
        <Link {...match} className={buttonVariants({ variant: "raised", size: "row" })}>
          Fix match
        </Link>
      </Cell>
    </TableRow>
  );
}
