/**
 * What happens at the end of an item in a movie group session (ADR 0017). The core keeps no
 * countdown, so the session's queue carries it: in the credits of an episode the host's client
 * queues the next episode first, every member who sees it there counts down on the session's
 * clock, and when the countdown or the item ends the host moves the session on. Watching the
 * credits takes the queued episode out again, which stops everyone's countdown. Items are compared
 * by key, so this module knows nothing of a domain's items.
 */
import { countdownLeftMs, positionAt } from "./clock";
import type { SessionClock } from "./clock";
import type { EpochMillis } from "./units";

/** How close to its end the session's position counts as the end of its item. */
const END_SLACK_MS = 500;

/** What `sessionNext` reads. */
export interface NextInput {
  readonly clock: SessionClock;
  /** The server's time as this member estimates it; null until it has. */
  readonly serverNow: EpochMillis | null;
  /** The length of the item as this member plays it; null while unknown. */
  readonly durationMs: number | null;
  /** The key of the episode after the item when it can play; null for none. */
  readonly nextKey: string | null;
  /** The key of what is queued first, or null when nothing is or the member may not see it. */
  readonly headKey: string | null;
  /** Whether anything is queued. */
  readonly queued: boolean;
  /** This member hosts the session, so they move it on. */
  readonly hosting: boolean;
  /** This member may move the clock and skip to what is queued. */
  readonly mayControl: boolean;
  /** The host chose to watch this item's credits, so its countdown does not start again. */
  readonly creditsWatched: boolean;
}

/** The next-episode countdown a member sees. */
export interface NextCountdown {
  /** How long is left before the session moves on. */
  readonly countdownMs: number;
  /** Plays the next episode now: for members who may control. */
  readonly canPlayNow: boolean;
  /** Takes the countdown away for everyone: for the host, who queued the episode. */
  readonly canWatchCredits: boolean;
}

/**
 * What the host does now. `queue`: put the next episode first in the queue, which starts everyone's
 * countdown. `next`: move the session on to what is queued first. `pause`: hold the session at the
 * end of an item with nothing after it.
 */
export type HostStep = "queue" | "next" | "pause";

/** What a member shows and, for the host, does. */
export interface SessionNext {
  readonly countdown: NextCountdown | null;
  readonly step: HostStep | null;
}

const NONE: SessionNext = { countdown: null, step: null };

/** Decides the next-episode countdown and the host's step for one instant. */
export const sessionNext = (input: NextInput): SessionNext => {
  const { clock, serverNow, durationMs, nextKey, hosting } = input;

  if (serverNow === null || durationMs === null || !(durationMs > 0)) return NONE;

  const left = countdownLeftMs(clock, serverNow, durationMs);

  if (left === null) return NONE;

  const counting = nextKey !== null && input.headKey === nextKey;

  const ended =
    clock.status === "playing" && positionAt(clock, serverNow) >= durationMs - END_SLACK_MS;

  const countdown =
    counting && left > 0
      ? { countdownMs: left, canPlayNow: input.mayControl, canWatchCredits: hosting }
      : null;

  if (!hosting) return { countdown, step: null };

  if (nextKey !== null && !counting && !input.creditsWatched) return { countdown, step: "queue" };

  if (counting && left === 0) return { countdown, step: "next" };

  if (!ended) return { countdown, step: null };

  return { countdown, step: input.queued ? "next" : "pause" };
};
