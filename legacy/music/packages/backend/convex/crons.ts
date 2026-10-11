import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "release expired job leases",
  { minutes: 1 },
  internal.maintenance.releaseExpiredLeases,
);

crons.interval(
  "pause sessions on offline devices",
  { minutes: 1 },
  internal.maintenance.pauseOrphanedSessions,
);

export default crons;
