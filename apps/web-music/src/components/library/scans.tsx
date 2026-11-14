import { usePlatform } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import type { ReactNode } from "react";

import { isActive } from "@/lib/job-progress";
import type { Scan } from "@/lib/job-progress";
import { useAllRows } from "@/lib/pages";
import { useRead } from "@/lib/platform";

type LibraryId = Awaited<ReturnType<PlatformSdk["core"]["libraries"]["get"]>>["libraryId"];

/** A music library's scan that is waiting or running, with the library's name. */
export interface ActiveScan extends Scan {
  readonly library: string;
}

/**
 * Renders `children` with the first waiting or running scan of a music library shared with you,
 * null when none runs, or `undefined` while the libraries load. Old music listed jobs; the core
 * shows each library's latest scan (`core.libraries.get`), which is the same for its one job kind.
 */
export function WithActiveScan({
  children,
}: {
  readonly children: (scan: ActiveScan | null | undefined) => ReactNode;
}) {
  const platform = usePlatform();

  const libraries = useAllRows(platform.core.libraries.list, (paginationOpts) => ({
    paginationOpts,
  }));

  if (libraries === undefined) return children(undefined);

  const music = libraries.filter((library) => library.kind === "music");

  return (
    <FirstActive libraries={music.map((library) => library.libraryId)}>{children}</FirstActive>
  );
}

function FirstActive({
  libraries,
  children,
}: {
  readonly libraries: ReadonlyArray<LibraryId>;
  readonly children: (scan: ActiveScan | null | undefined) => ReactNode;
}) {
  const [first, ...rest] = libraries;

  if (first === undefined) return children(null);

  return (
    <LibraryScan libraryId={first} rest={rest}>
      {children}
    </LibraryScan>
  );
}

function LibraryScan({
  libraryId,
  rest,
  children,
}: {
  readonly libraryId: LibraryId;
  readonly rest: ReadonlyArray<LibraryId>;
  readonly children: (scan: ActiveScan | null | undefined) => ReactNode;
}) {
  const platform = usePlatform();
  const library = useRead(platform.core.libraries.get, { libraryId });

  if (library === undefined) return children(undefined);

  if (library.scan !== null && isActive(library.scan)) {
    return children({ ...library.scan, library: library.name });
  }

  return <FirstActive libraries={rest}>{children}</FirstActive>;
}

/** The thin accent progress bar used for scans. */
export function ProgressBar({
  percent,
  className = "h-1",
  label,
}: {
  readonly percent: number;
  readonly className?: string;
  readonly label: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`flex shrink-0 overflow-hidden rounded-full bg-border ${className}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
