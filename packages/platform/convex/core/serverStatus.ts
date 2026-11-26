import { v } from "convex/values";

import type { DatabaseReader } from "../_generated/server";
import { fail } from "./lib/errors";
import { serverMutation } from "./lib/serverFacing";
import { transcodingReport } from "./serverReport";
import type { TranscodingReport } from "./serverReport";

const VERSION_CHARS_MAX = 64;

/** One GPU API per device a server could open, with room to spare. */
const DEVICES_MAX = 16;

/** Far past the capability keys today's operation table can list. */
const CAPABILITIES_MAX = 1000;

/** The media server cuts each line it reports to 200 characters. */
const TEXT_CHARS_MAX = 300;

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Every text of a transcoding report, to bound them. */
const textsOf = (report: TranscodingReport): ReadonlyArray<string | null> => [
  ...(report.build === null ? [] : [report.build.version, report.build.kernel]),
  ...report.devices.flatMap((device) => [
    device.domain,
    device.node,
    device.pci,
    device.kernelDriver,
    device.userDriver,
  ]),
  ...report.capabilities.flatMap((capability) => [
    capability.key,
    capability.domain,
    capability.detail,
  ]),
];

/**
 * What a media server says about itself, upserted into its own row with the server time of the
 * report, every few seconds while it runs. Refuses with `invalid_args` a version past 64
 * characters, a count that is not a whole number of at least 0, a start time that is not a time, or
 * a transcoding report past 16 devices, 1,000 capabilities, or 300 characters in any text.
 */
export const report = serverMutation({
  args: {
    version: v.string(),
    activeStreams: v.number(),
    runsAwaitingExit: v.number(),
    startedAt: v.number(),
    transcoding: transcodingReport,
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

    const { transcoding } = reported;

    if (
      transcoding.devices.length > DEVICES_MAX ||
      transcoding.capabilities.length > CAPABILITIES_MAX ||
      textsOf(transcoding).some((text) => text !== null && text.length > TEXT_CHARS_MAX)
    ) {
      fail(
        "invalid_args",
        `A transcoding report lists at most ${DEVICES_MAX} devices and ${CAPABILITIES_MAX} capabilities, each text at most ${TEXT_CHARS_MAX} characters`,
      );
    }

    const row = await ctx.db
      .query("serverReports")
      .withIndex("by_service", (q) => q.eq("serviceId", service.userId))
      .first();

    const fields = { ...reported, serviceId: service.userId, reportedAt: Date.now() };

    if (row === null) await ctx.db.insert("serverReports", fields);
    else await ctx.db.replace(row._id, fields);

    return null;
  },
});

/** The row of the server that reported last: one index entry, since an install runs one server. */
export const latestStatus = async (db: DatabaseReader) => {
  const row = await db.query("serverReports").withIndex("by_reported").order("desc").first();

  if (row === null) return null;

  return {
    version: row.version,
    activeStreams: row.activeStreams,
    runsAwaitingExit: row.runsAwaitingExit,
    startedAt: row.startedAt,
    reportedAt: row.reportedAt,
    transcoding: row.transcoding,
  };
};
