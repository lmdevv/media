/**
 * A sleep timer in one device's player: playback stops by itself after a set time or at the end of
 * the item playing. Its clock is the wall clock (`Date.now()`), so a tick that comes late, as on a
 * locked phone, never makes it late. When it runs out the sound fades for `SLEEP_FADE_MS`, then the
 * player pauses and stays paused until the viewer plays again. Pure: the player's owner keeps the
 * state, steps it with what the player reports, and carries out the fade and the pause. Items are
 * compared by key, so this module knows nothing of a domain's items.
 */
import { Data } from "effect";

import { EpochMillis } from "./units";

/** How long the sound fades out once the timer runs out, before playback pauses. */
export const SLEEP_FADE_MS = 10_000;

/** The timer lengths offered first, in minutes. */
export const SLEEP_PRESET_MINUTES = [15, 30, 45, 60, 90, 120] as const;

/** The most hours a custom timer takes. */
export const SLEEP_MAX_HOURS = 23;

const MINUTE_MS = 60_000;

/**
 * What a viewer sets. `after`: run out `minutes` from now. `itemEnd`: run out when the item with
 * `itemKey` ends, such as the episode playing.
 */
export type SleepChoice =
  | { readonly kind: "after"; readonly minutes: number }
  | { readonly kind: "itemEnd"; readonly itemKey: string };

/**
 * A sleep timer's state. `Slept` lasts until the viewer plays again: `heardPause` turns true once
 * the player reports itself paused, and until then the player must pause, so a report that it
 * still plays, sent while the pause takes effect, does not end it.
 */
export type SleepTimer = Data.TaggedEnum<{
  Off: {};
  Counting: { readonly endsAt: EpochMillis };
  ItemEnd: { readonly itemKey: string };
  Fading: { readonly pausesAt: EpochMillis };
  Slept: { readonly heardPause: boolean };
}>;

/** Constructors and matchers for `SleepTimer`. */
export const SleepTimer = Data.taggedEnum<SleepTimer>();

/** No timer, and the state after cancelling one. */
export const SLEEP_TIMER_OFF: SleepTimer = SleepTimer.Off();

/**
 * What the player reports to its sleep timer at one instant. It reports only once it can play, so
 * a player still loading never counts as paused.
 */
export interface SleepReading {
  /** The item playing, such as an episode, compared only by equality. */
  readonly itemKey: string;
  /** Wall-clock time until the item ends at the rate it plays; null while unknown. */
  readonly leftMs: number | null;
  readonly playing: boolean;
}

const instant = (ms: number): EpochMillis => EpochMillis.make(Math.round(ms));

/** Fades until `pausesAt`, or sleeps at once when that has passed. */
const fadeUntil = (pausesAt: number, now: EpochMillis): SleepTimer =>
  now >= pausesAt
    ? SleepTimer.Slept({ heardPause: false })
    : SleepTimer.Fading({ pausesAt: instant(pausesAt) });

/** The timer `choice` starts at `now`, whatever ran before. */
export const setSleepTimer = (choice: SleepChoice, now: EpochMillis): SleepTimer =>
  choice.kind === "after"
    ? SleepTimer.Counting({ endsAt: instant(now + choice.minutes * MINUTE_MS) })
    : SleepTimer.ItemEnd({ itemKey: choice.itemKey });

/**
 * The timer at `now`, given the player's latest report (null before any). A count runs out at its
 * end, and an item's end runs out once at most `SLEEP_FADE_MS` of the item is left, fading until it
 * ends; a report of another item cancels it. A fade sleeps when it reaches its pause. Returns
 * `timer` itself when nothing changes.
 */
export const stepSleepTimer = (
  timer: SleepTimer,
  reading: SleepReading | null,
  now: EpochMillis,
): SleepTimer =>
  SleepTimer.$match(timer, {
    Off: () => timer,
    Counting: ({ endsAt }) => (now < endsAt ? timer : fadeUntil(endsAt + SLEEP_FADE_MS, now)),
    ItemEnd: ({ itemKey }) => {
      if (reading === null) return timer;

      if (reading.itemKey !== itemKey) return SLEEP_TIMER_OFF;

      if (reading.leftMs === null || reading.leftMs > SLEEP_FADE_MS) return timer;

      return fadeUntil(now + Math.max(0, reading.leftMs), now);
    },
    Fading: ({ pausesAt }) => (now < pausesAt ? timer : SleepTimer.Slept({ heardPause: false })),
    Slept: ({ heardPause }) => {
      if (reading === null) return timer;

      if (!reading.playing) return heardPause ? timer : SleepTimer.Slept({ heardPause: true });

      return heardPause ? SLEEP_TIMER_OFF : timer;
    },
  });

/** Whether a timer runs: counting, waiting for an item's end, or fading. */
export const sleepTimerRuns = (timer: SleepTimer): boolean =>
  SleepTimer.$match(timer, {
    Off: () => false,
    Counting: () => true,
    ItemEnd: () => true,
    Fading: () => true,
    Slept: () => false,
  });

/**
 * How long until the timer runs out, for its label: 0 while it fades, and null when none runs or
 * the item's end is not known yet.
 */
export const sleepTimeLeftMs = (
  timer: SleepTimer,
  reading: SleepReading | null,
  now: EpochMillis,
): number | null =>
  SleepTimer.$match(timer, {
    Off: () => null,
    Counting: ({ endsAt }) => Math.max(0, endsAt - now),
    ItemEnd: ({ itemKey }) =>
      reading === null || reading.itemKey !== itemKey || reading.leftMs === null
        ? null
        : Math.max(0, reading.leftMs),
    Fading: () => 0,
    Slept: () => null,
  });

/** What scales the volume the viewer set: 1, falling linearly to 0 across the fade. */
export const sleepVolume = (timer: SleepTimer, now: EpochMillis): number =>
  SleepTimer.$is("Fading")(timer)
    ? Math.min(1, Math.max(0, (timer.pausesAt - now) / SLEEP_FADE_MS))
    : 1;

/**
 * Whether the player must not start the next item by itself, as the timer ends with `itemKey` or
 * has run out.
 */
export const sleepHoldsAutoplay = (timer: SleepTimer, itemKey: string): boolean =>
  SleepTimer.$match(timer, {
    Off: () => false,
    Counting: () => false,
    ItemEnd: (ending) => ending.itemKey === itemKey,
    Fading: () => true,
    Slept: () => true,
  });

/**
 * Whether the player must pause: the timer ran out and the player has not reported itself paused
 * since.
 */
export const sleepPausesPlayback = (timer: SleepTimer): boolean =>
  SleepTimer.$is("Slept")(timer) && !timer.heardPause;

/** Whether the player lets the screen turn off: the timer paused playback. */
export const sleepLetsScreenOff = (timer: SleepTimer): boolean => SleepTimer.$is("Slept")(timer);

/** How often to step the timer: often while it fades, so the fade is smooth; null for never. */
export const sleepTickMs = (timer: SleepTimer): number | null =>
  SleepTimer.$match(timer, {
    Off: () => null,
    Counting: () => 1_000,
    ItemEnd: () => 1_000,
    Fading: () => 200,
    Slept: () => null,
  });

/**
 * A custom timer's length in minutes, or null when it is no time or out of range: up to
 * `SLEEP_MAX_HOURS` hours and 59 minutes.
 */
export const customSleepMinutes = (hours: number, minutes: number): number | null => {
  const valid =
    Number.isInteger(hours) &&
    Number.isInteger(minutes) &&
    hours >= 0 &&
    hours <= SLEEP_MAX_HOURS &&
    minutes >= 0 &&
    minutes < 60;

  const total = hours * 60 + minutes;

  return valid && total > 0 ? total : null;
};

/** Time left as a countdown, `29:41` or `1:05:00`, rounded up so it reads `0:01` until the end. */
export const formatSleepTimeLeft = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${String(minutes)}:${seconds}`;
};
