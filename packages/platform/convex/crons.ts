import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep sign-in rows", { hours: 1 }, internal.core.auth.sweep.sweep, {});

/**
 * The one lease-release cron, for every job kind (ADR 0012); domains never register their own.
 * Every 10 seconds, so a job whose worker died is back in the queue within its lease plus 10 s.
 */
crons.interval(
  "release expired job leases",
  { seconds: 10 },
  internal.core.jobs.leases.releaseExpired,
);

export default crons;
