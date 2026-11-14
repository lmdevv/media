import type { PlatformSdk } from "@media/sdk/promise";

import { formatCount } from "./format";

/** A library's latest scan, as `core.libraries.get` answers it. */
export type Scan = NonNullable<
  Awaited<ReturnType<PlatformSdk["core"]["libraries"]["get"]>>["scan"]
>;

/** Whether a scan is still waiting or running. */
export const isActive = (scan: Pick<Scan, "status">): boolean =>
  scan.status === "queued" || scan.status === "running";

/** Percent complete for a scan, or null while the total is unknown. */
export const jobPercent = (scan: Pick<Scan, "done" | "total" | "status">): number | null => {
  if (scan.status === "succeeded") return 100;

  if (scan.done === null || scan.total === null || scan.total === 0) return null;

  return Math.min(100, Math.floor((scan.done / scan.total) * 100));
};

/**
 * `~6 MIN LEFT` from a running scan's progress rate, or null until there is enough to estimate.
 * A scan that is no longer running, or has read everything it counted, has nothing left.
 */
export const jobEta = (
  scan: Pick<Scan, "done" | "total" | "startedAt" | "status">,
  now: number,
): string | null => {
  if (scan.status !== "running") return null;

  if (scan.total === null || scan.startedAt === null || scan.done === null || scan.done === 0) {
    return null;
  }

  if (scan.done >= scan.total) return null;

  const rate = scan.done / Math.max(1, now - scan.startedAt);
  const minutes = Math.ceil((scan.total - scan.done) / rate / 60_000);

  return minutes <= 1 ? "UNDER A MINUTE LEFT" : `~${formatCount(minutes)} MIN LEFT`;
};
