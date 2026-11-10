import { v } from "convex/values";

import type { DatabaseReader } from "../_generated/server";
import { fail } from "./lib/errors";
import { serverMutation } from "./lib/serverFacing";

const VERSION_CHARS_MAX = 64;

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * What a media server says about itself, upserted into its own row with the server time of the
 * report, every few seconds while it runs. Refuses with `invalid_args` a version past 64
 * characters, a count that is not a whole number of at least 0, or a start time that is not a time.
 */
export const report = serverMutation({
  args: {
    version: v.string(),
    hardwareAcceleration: v.union(v.literal("qsv"), v.literal("vaapi"), v.literal("none")),
    activeStreams: v.number(),
    runsAwaitingExit: v.number(),
    startedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, reported, service) => {
    if (reported.version.length === 0 || reported.version.length > VERSION_CHARS_MAX) {
      fail("invalid_args", `A version has 1 to ${VERSION_CHARS_MAX} characters`);
    }

    if (!isCount(reported.activeStreams) || !isCount(reported.runsAwaitingExit)) {
      fail("invalid_args", "Streams and runs are counted in whole numbers of at least 0");
    }

    if (!Number.isFinite(reported.startedAt) || reported.startedAt < 0) {
      fail("invalid_args", "A start time is a time since the epoch in milliseconds");
    }

    const row = await ctx.db
      .query("serverStatus")
      .withIndex("by_service", (q) => q.eq("serviceId", service.userId))
      .first();

    const fields = { ...reported, serviceId: service.userId, reportedAt: Date.now() };

    if (row === null) await ctx.db.insert("serverStatus", fields);
    else await ctx.db.replace(row._id, fields);

    return null;
  },
});

/** The row of the server that reported last: one index entry, since an install runs one server. */
export const latestStatus = async (db: DatabaseReader) => {
  const row = await db.query("serverStatus").withIndex("by_reported").order("desc").first();

  if (row === null) return null;

  return {
    version: row.version,
    hardwareAcceleration: row.hardwareAcceleration,
    activeStreams: row.activeStreams,
    runsAwaitingExit: row.runsAwaitingExit,
    startedAt: row.startedAt,
    reportedAt: row.reportedAt,
  };
};
