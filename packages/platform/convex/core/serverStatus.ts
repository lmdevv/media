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

/** A capability key, such as `decode.qsv:hevc/yuv420p10le`. */
const KEY_CHARS_MAX = 80;

/** A domain, render node, PCI id, kernel driver, ffmpeg version, or kernel release. */
const NAME_CHARS_MAX = 64;

/** A userspace driver's name and version. */
const DRIVER_CHARS_MAX = 128;

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * Every text of a transcoding report with the most characters it may have. At these caps, with
 * every character three bytes in UTF-8, the largest report stays under Convex's 1 MiB document.
 */
const textsOf = (report: TranscodingReport): ReadonlyArray<readonly [string | null, number]> => [
  ...(report.build === null
    ? []
    : [
        [report.build.version, NAME_CHARS_MAX] as const,
        [report.build.kernel, NAME_CHARS_MAX] as const,
      ]),
  ...report.devices.flatMap((device) => [
    [device.domain, NAME_CHARS_MAX] as const,
    [device.node, NAME_CHARS_MAX] as const,
    [device.pci, NAME_CHARS_MAX] as const,
    [device.kernelDriver, NAME_CHARS_MAX] as const,
    [device.userDriver, DRIVER_CHARS_MAX] as const,
  ]),
  ...report.capabilities.flatMap((capability) => [
    [capability.key, KEY_CHARS_MAX] as const,
    [capability.domain, NAME_CHARS_MAX] as const,
  ]),
];

/**
 * What a media server says about itself, upserted into its own row with the server time of the
 * report, every few seconds while it runs. Refuses with `invalid_args` a version past 64
 * characters, a count that is not a whole number of at least 0, a start time that is not a time, or
 * a transcoding report past 16 devices or 1,000 capabilities, or with a key past 80 characters, a
 * driver past 128, or any other text past 64.
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
      textsOf(transcoding).some(([text, most]) => text !== null && text.length > most)
    ) {
      fail(
        "invalid_args",
        `A transcoding report lists at most ${DEVICES_MAX} devices and ${CAPABILITIES_MAX} capabilities, keys of at most ${KEY_CHARS_MAX} characters, drivers of at most ${DRIVER_CHARS_MAX}, and other texts of at most ${NAME_CHARS_MAX}`,
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
