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

export default crons;
