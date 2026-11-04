import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep sign-in rows", { hours: 1 }, internal.core.auth.sweep.sweep, {});

export default crons;
