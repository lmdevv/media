import { v } from "convex/values";

import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "./lib/errors";
import { inOrder } from "./lib/inOrder";
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

/**
 * How long a media server may stay silent before every client hears it is away: it beats every 15
 * seconds, so this misses two beats before it counts.
 */
export const AWAY_MS = 40_000;

const SWEEP_MAX = 100;

/**
 * Records that the calling media server runs. Writes its beat, which no query reads, and its
 * presence only when it comes back, so a beat re-runs no one's view.
 */
export const beat = serverMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx, _args, service) => {
    const now = Date.now();
    const { userId: serviceId } = service;

    const seen = await ctx.db
      .query("serverBeats")
      .withIndex("by_service", (q) => q.eq("serviceId", serviceId))
      .unique();

    if (seen === null) await ctx.db.insert("serverBeats", { serviceId, seenAt: now });
    else await ctx.db.patch(seen._id, { seenAt: now });

    const presence = await ctx.db
      .query("serverPresence")
      .withIndex("by_service", (q) => q.eq("serviceId", serviceId))
      .unique();

    if (presence === null) {
      await ctx.db.insert("serverPresence", { serviceId, awaySince: null, changedAt: now });
    } else if (presence.awaySince !== null) {
      await ctx.db.patch(presence._id, { awaySince: null, changedAt: now });
    }

    return null;
  },
});

/**
 * Marks away each media server silent for `AWAY_MS` as of `asOf` (now, or a later time a test
 * passes instead of waiting), dropping its beat until it beats again. Writes use the real time. A
 * full batch runs the next one at once.
 */
export const sweep = internalMutation({
  args: { asOf: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { asOf }) => {
    const now = Date.now();

    const silent = await ctx.db
      .query("serverBeats")
      .withIndex("by_seen", (q) => q.lt("seenAt", (asOf ?? now) - AWAY_MS))
      .take(SWEEP_MAX);

    await inOrder(silent, async (seen) => {
      await ctx.db.delete(seen._id);

      const presence = await ctx.db
        .query("serverPresence")
        .withIndex("by_service", (q) => q.eq("serviceId", seen.serviceId))
        .unique();

      if (presence?.awaySince === null) {
        await ctx.db.patch(presence._id, { awaySince: now, changedAt: now });
      }
    });

    if (silent.length === SWEEP_MAX) {
      await ctx.scheduler.runAfter(
        0,
        internal.core.serverStatus.sweep,
        asOf === undefined ? {} : { asOf },
      );
    }

    return null;
  },
});

/**
 * Whether the media server whose presence changed last beats: `away` once the sweep found it
 * silent, null before any server beat. An install runs one server.
 */
export const latestPresence = async (db: DatabaseReader): Promise<"present" | "away" | null> => {
  const row = await db.query("serverPresence").withIndex("by_changed").order("desc").first();

  if (row === null) return null;

  return row.awaySince === null ? "present" : "away";
};

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
