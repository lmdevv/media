import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "release expired job leases",
  { minutes: 1 },
  internal.maintenance.releaseExpiredLeases,
);

export default crons;
