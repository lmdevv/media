import { v } from "convex/values";
import type { Infer } from "convex/values";

import { domainItem } from "../../../commands/access";
import { contentDomain } from "../../../commands/scopes";

/** Who may join: anyone with the link, anyone the host lets in, or no one new (ADR 0017). */
export const joinSetting = v.union(v.literal("open"), v.literal("approval"), v.literal("locked"));

/**
 * The shared clock. While playing, the position at server time `t` is `positionAtAnchorMs + (t -
 * anchorServerTime) * playbackRate`; while paused it is `positionAtAnchorMs`. Every move bumps
 * `revision`, so a client applies only a higher one.
 */
export const clock = v.object({
  status: v.union(v.literal("playing"), v.literal("paused")),
  positionAtAnchorMs: v.number(),
  anchorServerTime: v.number(),
  playbackRate: v.number(),
  revision: v.number(),
});

/** What the host lets in and what every guest may do; the host may always do both. */
export const settings = v.object({ join: joinSetting, control: v.boolean(), add: v.boolean() });

const sessionFields = {
  /** Never changes: there is no handoff, and the host leaving ends the session. */
  hostId: v.id("users"),
  /**
   * The secret half of the join link, kept as made so members can copy the link again. The link
   * lets only signed-in household people ask to join, under the join setting.
   */
  linkSecret: v.string(),
  settings,
  /** People the host removed or turned away; the link no longer lets them in. */
  blocked: v.array(v.id("users")),
  clock,
  /** What plays now. Its domain is the session's, and never changes. */
  item: domainItem,
};

export const sessionDocument = v.union(
  v.object({ ...sessionFields, state: v.literal("live") }),
  v.object({
    ...sessionFields,
    state: v.literal("ended"),
    reason: v.union(v.literal("host-left"), v.literal("abandoned")),
  }),
);

/**
 * A person in a session, joined or waiting for the host. At most one row per person and domain.
 * `awaySince` changes only when they go away or come back, so heartbeats re-run no one's view.
 */
export const memberDocument = v.object({
  sessionId: v.id("togetherSessions"),
  userId: v.id("users"),
  /** The session's domain, copied once, for the one-row-per-domain lookup. */
  domain: contentDomain,
  state: v.union(v.literal("pending"), v.literal("joined")),
  /** When they went away, or null while they are present. */
  awaySince: v.union(v.number(), v.null()),
});

/**
 * The hot half of presence: a member's last heartbeat, kept only while they are present. No
 * subscribed query reads it.
 */
export const beatDocument = v.object({
  sessionId: v.id("togetherSessions"),
  memberId: v.id("togetherMembers"),
  seenAt: v.number(),
});

/** An item queued to play next, in ascending `order`; playing it takes it out of the queue. */
export const entryDocument = v.object({
  sessionId: v.id("togetherSessions"),
  order: v.number(),
  item: domainItem,
  addedBy: v.id("users"),
});

export type Clock = Infer<typeof clock>;

export type JoinSetting = Infer<typeof joinSetting>;

export type Settings = Infer<typeof settings>;

/** A join link is `mt_<sessionId>.<secret>`. */
export const LINK_PREFIX = "mt";

export const LINK_SECRET_BYTES = 24;

/** Joined members, the host included. */
export const MEMBERS_MAX = 50;

/** People waiting for the host at once. */
export const PENDING_MAX = 20;

/** People the host removed or turned away in one session. */
export const BLOCKED_MAX = 100;

/** Items queued in one session at once. */
export const QUEUE_MAX = 500;

/** How often a client sends a heartbeat while the session is open on screen. */
export const HEARTBEAT_MS = 5_000;

/** A member silent this long is away; a host away pauses a playing session. */
export const PRESENT_MS = 30_000;

/** Heartbeats closer than this to the last write write nothing, so a burst of samples is free. */
export const BEAT_WRITE_MS = 1_000;

/** A session whose host has been away this long ends. */
export const ABANDON_MS = 30 * 60_000;

/** An ended session stays readable this long, so every member sees it ended, then is purged. */
export const ENDED_KEEP_MS = 60 * 60_000;

export const RATE_MIN = 0.5;

export const RATE_MAX = 2;

export const JOINS_PER_HOUR = 60;

export const CREATES_PER_HOUR = 30;
