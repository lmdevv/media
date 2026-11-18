import { v } from "convex/values";
import type { Infer } from "convex/values";

import { domainItem } from "../../../commands/access";

/**
 * Where a device's picture and sound go: the device itself, or a Chromecast or AirPlay receiver it
 * drives (ADR 0018). A receiver may have no name, as Safari leaves some AirPlay receivers.
 */
export const output = v.union(
  v.object({ kind: v.literal("local") }),
  v.object({ kind: v.literal("cast"), receiver: v.union(v.string(), v.null()) }),
  v.object({ kind: v.literal("airplay"), receiver: v.union(v.string(), v.null()) }),
);

/** Play or pause at a position in server time: `positionMs` held at `at`. */
const anchored = { playing: v.boolean(), positionMs: v.number(), at: v.number() };

/**
 * What a controller asks of a device. `transport` plays or pauses `item` at a position, and holds
 * only while the device still plays that item, so a pause sent for one song never lands on the
 * next. `load` plays `item` from a position, whatever the device plays; `loadRevision` is the
 * revision that first asked for it, and a device that already started that load only plays,
 * pauses, or seeks what it plays. `stop` plays nothing: the source's half of moving playback.
 */
export const ask = v.union(
  v.object({ kind: v.literal("transport"), item: domainItem, ...anchored }),
  v.object({ kind: v.literal("load"), item: domainItem, ...anchored, loadRevision: v.number() }),
  v.object({ kind: v.literal("stop"), at: v.number() }),
);

/** What a controller asks of a device. */
export type Ask = Infer<typeof ask>;

/** What a device says it plays: an item, and the group session it follows, if any. */
const reported = v.object({
  item: domainItem,
  playing: v.boolean(),
  positionMs: v.number(),
  /** The group session the device follows, one its reporting person was in when it said so. */
  session: v.optional(v.id("togetherSessions")),
});

/** What a device last said it plays, one row per device (ADR 0018). */
export const playerDocument = v.object({
  deviceId: v.id("devices"),
  /** The session that reported; the device is no target once that session ends. */
  reporter: v.id("authSessions"),
  output,
  /** Null while the device plays nothing. Its position held at `reportedAt`. */
  playback: v.union(v.null(), reported),
  /** The revision up to which requests are done for `reporter`. */
  settled: v.number(),
  /** Server time of the report. */
  reportedAt: v.number(),
});

/** The playback controllers last asked of a device, one row per device (ADR 0018). */
export const requestDocument = v.object({
  deviceId: v.id("devices"),
  /** The session it was made for; it never applies to another one on the device. */
  reporter: v.id("authSessions"),
  /** Higher than every revision before it on this device. */
  revision: v.number(),
  ask,
});
