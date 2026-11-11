import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { PageHeader } from "@media/ui/components/page-header";
import { ProgressBar } from "@media/ui/components/progress-bar";
import { Skeleton } from "@media/ui/components/skeleton";
import { Spinner } from "@media/ui/components/spinner";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { usePages } from "@media/ui/lib/pages";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { RotateCwIcon } from "lucide-react";

import { useNow } from "@media/ui/lib/use-now";
import { useMe } from "@/session/session";

import { useAction } from "./action";
import { formatCount, formatPercent, plural } from "./format";
import { isActive, lastScanLabel, scanFraction } from "./scan";
import { ACCOUNT_LIBRARIES } from "@/lib/account-links";
import { reportMovedOn } from "@/lib/canceled";

import { PagedView, ShowMore } from "./paged-view";
import { allows } from "./scope-gate";
import { Cell, Column, StatusDot, Table, TableHead } from "./table";
import type { Library, LibraryDetail, Scan } from "./types";

/** Where an admin creates, renames, re-folders, and shares libraries: the account client (D57). */
export const accountLibraryHref = (library?: Library["libraryId"]): string =>
  library === undefined ? ACCOUNT_LIBRARIES : `${ACCOUNT_LIBRARIES}/${library}`;

/** Whether the movies admin lists `library`: a movies library the person may scan and fix. */
const editable = (library: Library): boolean =>
  library.kind === "movies" && library.level !== "view";

/**
 * Libraries and scans: every movies library this person may edit, with its folders, size, last
 * scan, and live scan progress. Admins make and share libraries in the account client.
 */
export function LibrariesScreen() {
  const platform = usePlatform();
  const me = useMe();
  const now = useNow(10_000);
  const admin = me !== null && allows(me, "admin");

  const libraries = usePages(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const list = libraries.status === "ready" ? libraries.rows.filter(editable) : [];

  const scanAll = useAction(
    async () => {
      const scans = await Promise.all(
        list.map((library) => platform.core.libraries.scan({ libraryId: library.libraryId })),
      );

      return scans.filter((scan) => scan.created).length;
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
            {admin ? (
              <a
                href={accountLibraryHref()}
                className={cn(buttonVariants({ size: "xs" }), "font-semibold")}
              >
                Manage in account
              </a>
            ) : null}
          </>
        }
      />
      <PagedView list={libraries} loading={<Skeleton className="h-36 w-full rounded-control" />}>
        {({ next }) => (
          <>
            {list.length === 0 && next.kind === "done" ? (
              <p className="font-sans text-body/body text-text-muted">
                No movies library is shared with you to manage.
              </p>
            ) : (
              <Table label="Libraries">
                <TableHead>
                  <Column className="w-40">Name</Column>
                  <Column className="min-w-50 flex-1">Path</Column>
                  <Column className="w-37">Items</Column>
                  <Column className="w-30">Last scan</Column>
                  <Column className="w-25">Status</Column>
                  <Column className="w-22" />
                </TableHead>
                {list.map((library) => (
                  <LibraryRow key={library.libraryId} library={library} now={now} />
                ))}
              </Table>
            )}
            <ShowMore next={next} />
          </>
        )}
      </PagedView>
    </>
  );
}

function ScanStatus({ scan }: { readonly scan: Scan | null }) {
  if (isActive(scan)) {
    return (
      <>
        <Spinner className="size-3 text-text" />
        <span className="font-sans text-label/label text-text">
          {scan?.status === "queued"
            ? "Queued"
            : scan?.canceling === true
              ? "Canceling"
              : "Scanning"}
        </span>
      </>
    );
  }

  if (scan?.status === "failed") {
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

function LibraryRow({ library, now }: { readonly library: Library; readonly now: number }) {
  const platform = usePlatform();
  const query = usePlatformQuery(platform.core.libraries.get, { libraryId: library.libraryId });
  const detail: LibraryDetail | null = query.status === "success" ? query.data : null;
  const scan = detail?.scan ?? null;
  const active = isActive(scan);
  const startScan = useAction(() => platform.core.libraries.scan({ libraryId: library.libraryId }));

  const stopScan = useAction(
    (seen: Pick<Scan, "jobId" | "attempt">) =>
      platform.core.libraries.cancelScan({ jobId: seen.jobId, attempt: seen.attempt }),
    { onSuccess: (answer) => reportMovedOn([answer], "scan") },
  );

  const running = scan?.status === "running" ? scan : null;
  const fraction = running === null ? null : scanFraction(running);

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
            params={{ libraryId: library.libraryId }}
            className="truncate font-sans text-label/label font-semibold text-text hover:underline"
          >
            {library.name}
          </Link>
        </Cell>
        <Cell className="min-w-50 flex-1 truncate font-mono text-caption/caption text-text-muted">
          {detail?.folders?.join(", ") ?? ""}
        </Cell>
        <Cell className="w-37 font-mono text-caption/caption text-text">
          {detail?.items === null || detail?.items === undefined
            ? ""
            : plural(detail.items, "title")}
        </Cell>
        <Cell className="w-30 font-mono text-caption/caption text-text-muted">
          {detail === null ? "" : lastScanLabel(scan, now)}
        </Cell>
        <Cell className="flex w-25 items-center gap-1.5">
          {detail === null ? null : <ScanStatus scan={scan} />}
        </Cell>
        <Cell className="flex w-22 justify-end">
          {active && scan !== null && !scan.canceling ? (
            <button
              type="button"
              disabled={stopScan.pending}
              onClick={() => void stopScan.run(scan)}
              aria-label={`Cancel the scan of ${library.name}`}
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
      {running === null ? null : (
        <div className="flex flex-col gap-2 pr-3 pb-3.5 pl-10.5">
          <div className="flex items-center gap-3">
            <ProgressBar
              tone="surface"
              value={fraction ?? 0}
              label={`${library.name} scan progress`}
              className="flex-1 rounded-pill bg-hairline [&>div]:rounded-pill"
            />
            <span className="w-55 shrink-0 text-right font-mono text-caption/caption text-text">
              {running.done === null
                ? ""
                : running.total === null
                  ? `${formatCount(running.done)} files`
                  : `${formatCount(running.done)} / ${formatCount(running.total)} files · ${formatPercent(fraction ?? 0)}`}
            </span>
          </div>
          {running.message === null ? null : (
            <span className="truncate font-mono text-caption/caption text-text-muted">
              {running.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
