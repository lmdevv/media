import { folderTroubleOf } from "@media/contracts/scan-failure";

import { isActive as isJobActive } from "@/lib/scan-progress";

import { formatAgo } from "./format";
import type { Scan } from "./types";

/** Whether a library's latest scan is still queued or running. */
export const isActive = (scan: Scan | null): boolean => scan !== null && isJobActive(scan);

/** Whether a failed scan could not read the library's folders, such as an offline NAS share. */
export const isUnreachable = (scan: Scan | null): scan is Scan =>
  scan !== null && scan.status === "failed" && folderTroubleOf(scan.error) === "offline";

/** When a library was last scanned: `queued`, `running`, `never`, or how long ago it finished. */
export const lastScanLabel = (scan: Scan | null, now: number): string => {
  if (scan?.status === "queued") return "queued";

  if (scan?.status === "running") return "running";

  return scan?.finishedAt === null || scan?.finishedAt === undefined
    ? "never"
    : formatAgo(scan.finishedAt, now);
};

/** How far a running scan has come, from 0 to 1; null while its total is unknown. */
export const scanFraction = (scan: Scan): number | null =>
  scan.done === null || scan.total === null || scan.total <= 0
    ? null
    : Math.min(1, scan.done / scan.total);
