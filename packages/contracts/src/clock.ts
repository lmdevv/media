import type { RoomClock } from "./models/rooms";
import { EpochMillis, Milliseconds } from "./units";

/** How often the host and guests send room heartbeats. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * A host heartbeat re-anchors the shared timeline only when the host's player is further than
 * this from the computed position, so small jitter does not churn revisions. Guests follow the
 * timeline, not the host, so it bounds how far they can sit from the host: a host's player starts
 * a little after the command that anchored it.
 */
export const HOST_REANCHOR_THRESHOLD_MS = 50;

/**
 * The threshold for a heartbeat that does not say when the host read its position: the request's
 * travel time counts as drift there, so a tight threshold would re-anchor on every slow request.
 */
export const UNTIMED_HOST_REANCHOR_THRESHOLD_MS = 250;

/**
 * How long a room's next-episode countdown runs: from the host's player reaching the credits to the
 * whole room moving on, unless the host cancels it first. Solo playback counts down as long.
 */
export const NEXT_EPISODE_COUNTDOWN_MS = 10_000;

/** The part of a room clock that determines the live position. */
export type ClockAnchor = Pick<
  RoomClock,
  "status" | "positionAtAnchorMs" | "anchorServerTime" | "playbackRate"
>;

/**
 * The shared position at `serverNow`. Playing clocks advance from their anchor at their rate;
 * paused, buffering, and ended clocks stay at the anchor.
 */
export const targetPosition = (clock: ClockAnchor, serverNow: EpochMillis): Milliseconds => {
  if (clock.status !== "playing") return clock.positionAtAnchorMs;
  const elapsed = Math.max(0, serverNow - clock.anchorServerTime);

  return Milliseconds.make(clock.positionAtAnchorMs + elapsed * clock.playbackRate);
};

/** A host heartbeat's position as the server compares it with the shared position. */
export interface HostReading {
  /** Where the host's player is at the server's now. */
  readonly positionMs: Milliseconds;
  /** How far from the shared position it may be before the clock re-anchors on it. */
  readonly thresholdMs: number;
}

/**
 * Reads a host heartbeat's `positionMs` at `serverNow`. A reading timed by `atServerTime`, when the
 * host read it by its estimate of the server clock, is carried forward to `serverNow` in a playing
 * room, so the request's travel time is not drift, and gets `HOST_REANCHOR_THRESHOLD_MS`. A reading
 * without a time, or with one that cannot be right (more than `HOST_REANCHOR_THRESHOLD_MS` ahead,
 * or older than a heartbeat interval, as after the host's clock stepped), counts as read at
 * `serverNow` and gets `UNTIMED_HOST_REANCHOR_THRESHOLD_MS`.
 */
export const hostReading = (
  clock: ClockAnchor,
  positionMs: Milliseconds,
  atServerTime: EpochMillis | undefined,
  serverNow: EpochMillis,
): HostReading => {
  const ageMs = atServerTime === undefined ? null : serverNow - atServerTime;

  if (ageMs === null || ageMs < -HOST_REANCHOR_THRESHOLD_MS || ageMs > HEARTBEAT_INTERVAL_MS) {
    return { positionMs, thresholdMs: UNTIMED_HOST_REANCHOR_THRESHOLD_MS };
  }

  const carriedMs = clock.status === "playing" ? Math.max(0, ageMs) * clock.playbackRate : 0;

  return {
    positionMs: Milliseconds.make(positionMs + carriedMs),
    thresholdMs: HOST_REANCHOR_THRESHOLD_MS,
  };
};

/**
 * Whether `incoming` should replace the clock a client last applied. Clocks arrive over several
 * paths (subscription, command result, optimistic update); only a higher revision wins.
 */
export const isNewerRevision = (
  incoming: Pick<RoomClock, "revision">,
  applied: Pick<RoomClock, "revision"> | undefined,
): boolean => applied === undefined || incoming.revision > applied.revision;

/** One round trip to the server's clock, in the client's own milliseconds. */
export interface ClockSample {
  /** Client time when the request was sent. */
  readonly sentAt: number;
  /** Server time in the response. */
  readonly serverTime: EpochMillis;
  /** Client time when the response arrived. */
  readonly receivedAt: number;
}

/** An estimate of `serverTime - clientTime` and the round trip it came from. */
export interface ClockOffset {
  readonly offsetMs: number;
  readonly roundTripMs: number;
}

/**
 * Estimates the server clock offset from round-trip samples, trusting the sample with the shortest
 * round trip and assuming the server read its clock halfway through it. A sample whose client clock
 * stepped back while it was out (an NTP correction) has no meaningful round trip and is ignored.
 * Returns `undefined` when no sample is usable.
 */
export const estimateClockOffset = (
  samples: ReadonlyArray<ClockSample>,
): ClockOffset | undefined => {
  const usable = samples.filter((sample) => sample.receivedAt >= sample.sentAt);

  const best = usable.reduce<ClockSample | undefined>(
    (shortest, sample) =>
      shortest === undefined ||
      sample.receivedAt - sample.sentAt < shortest.receivedAt - shortest.sentAt
        ? sample
        : shortest,
    undefined,
  );

  if (best === undefined) return undefined;
  const roundTripMs = best.receivedAt - best.sentAt;

  return { offsetMs: best.serverTime - (best.sentAt + roundTripMs / 2), roundTripMs };
};

/** The server time corresponding to a client instant, given an estimated offset. */
export const toServerTime = (clientNow: number, offset: ClockOffset): EpochMillis =>
  EpochMillis.make(Math.max(0, Math.round(clientNow + offset.offsetMs)));
