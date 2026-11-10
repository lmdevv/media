import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep sign-in rows", { hours: 1 }, internal.core.auth.sweep.sweep, {});

crons.interval(
  "release expired job leases",
  { seconds: 10 },
  internal.core.jobs.leases.releaseExpired,
);

crons.interval(
  "mark silent group-session members away",
  { seconds: 10 },
  internal.core.together.presence.sweep,
  {},
);

crons.interval("delete week-old finished jobs", { hours: 1 }, internal.core.jobs.cleanup.sweep, {});

crons.daily(
  "request the nightly backup",
  { hourUTC: 3, minuteUTC: 0 },
  internal.core.backups.nightly,
  {},
);

export default crons;
