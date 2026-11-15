/**
 * The shared clock of a group session (ADR 0017), as every client follows it. The core stores an
 * anchored clock and moves it only on a member's control; each member estimates the server's time
 * from heartbeats and computes the live position on its own, then corrects its player toward it.
 *
 * The thresholds and cadences here are tuning defaults, not guarantees.
 */
import { EpochMillis } from "./units";

/**
 * A group session's clock, as `core.together.get` and `core.together.control` answer it. While
 * playing, the position at server time `t` is `positionAtAnchorMs + (t - anchorServerTime) *
 * playbackRate`; while paused it is `positionAtAnchorMs`. Every move bumps `revision`.
 */
export interface SessionClock {
  readonly status: "playing" | "paused";
  /** The position, in milliseconds of media, at `anchorServerTime`. */
  readonly positionAtAnchorMs: number;
  /** The server's time, in epoch milliseconds, when the clock last moved. */
  readonly anchorServerTime: number;
  readonly playbackRate: number;
  /** Bumped by every move; a client applies only a higher one. */
  readonly revision: number;
}

/** How often a member sends a heartbeat while it is in a session, on any screen. */
export const HEARTBEAT_MS = 5_000;

/**
 * A member silent this long counts as away. A host away this long pauses a playing session, which
 * plays on only once someone plays it again.
 */
export const AWAY_AFTER_MS = 30_000;

/**
 * How a member samples the server's clock: a burst of `burst` heartbeats `spacingMs` apart every
 * `everyMs`, estimating the offset from the shortest round trip of the last `kept`. A burst's
 * heartbeats after the first write nothing, so their round trips hold no commit.
 */
export const CLOCK_SAMPLING = { burst: 5, spacingMs: 50, everyMs: 30_000, kept: 10 } as const;

/** Drift correction thresholds for a following player. */
export const DRIFT_THRESHOLDS = {
  /** Within this distance the player is in sync and left alone. */
  inSyncMs: 120,
  /** Beyond this distance the player seeks; between the two it adjusts its rate. */
  seekMs: 1_500,
  /** How far from the session's rate a nudging player runs, as a fraction. */
  nudgeRate: 0.05,
} as const;

/**
 * How long a next-episode countdown runs: from the credits to moving on, unless someone moves on
 * sooner or the host watches the credits instead. Solo playback counts down as long.
 */
export const NEXT_EPISODE_COUNTDOWN_MS = 10_000;

/** The longest stretch at the end of an item that counts as its credits. */
const CREDITS_MAX_MS = 30_000;

/** The share of an item at its end that counts as its credits, up to `CREDITS_MAX_MS`. */
const CREDITS_SHARE = 0.1;

/**
 * The shared position at `serverNow`. A playing clock advances from its anchor at its rate, never
 * backwards when `serverNow` predates the anchor; a paused clock stays at the anchor.
 */
export const positionAt = (clock: SessionClock, serverNow: EpochMillis): number =>
  clock.status === "playing"
    ? clock.positionAtAnchorMs +
      Math.max(0, serverNow - clock.anchorServerTime) * clock.playbackRate
    : clock.positionAtAnchorMs;

/**
 * Whether `incoming` should replace the clock a client last applied. Clocks arrive over several
 * paths (the subscription, a control's answer); only a higher revision wins.
 */
export const isNewerRevision = (
  incoming: Pick<SessionClock, "revision">,
  applied: Pick<SessionClock, "revision"> | undefined,
): boolean => applied === undefined || incoming.revision > applied.revision;

/** Where an item `durationMs` long starts its credits: its last tenth, at most 30 seconds. */
export const creditsStartMs = (durationMs: number): number =>
  durationMs - Math.min(CREDITS_MAX_MS, durationMs * CREDITS_SHARE);

/**
 * How long is left of the next-episode countdown at `serverNow`, for an item `durationMs` long, or
 * null before its credits. The countdown runs on the session's clock, so every member counts down
 * together and a pause holds it; it ends `NEXT_EPISODE_COUNTDOWN_MS` into the credits, or at the
 * item's end when the credits are shorter.
 */
export const countdownLeftMs = (
  clock: SessionClock,
  serverNow: EpochMillis,
  durationMs: number,
): number | null => {
  if (!(durationMs > 0)) return null;

  const credits = creditsStartMs(durationMs);
  const position = positionAt(clock, serverNow);

  if (position < credits) return null;

  const due = Math.min(credits + NEXT_EPISODE_COUNTDOWN_MS, durationMs);

  return Math.max(0, due - position) / clock.playbackRate;
};

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
