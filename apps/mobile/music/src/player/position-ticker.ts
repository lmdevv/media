import { devicePosition } from "@media/player/connect-devices";
import type { DevicePlayback } from "@media/player/connect-devices";

/** What decides whether the live position moves on screen. */
export interface TickerInputs {
  /** The position the screens show advances: a song plays here, or on the device they follow. */
  readonly playing: boolean;
  /** The app is on screen. */
  readonly foreground: boolean;
  /** How many mounted components show the position, such as the scrubber or the mini player. */
  readonly readers: number;
}

/**
 * Whether the position is read on a timer: only while it moves and someone on screen shows it.
 * The lock screen and Connect reports never need the timer; the player tells them of each change
 * of play state or jump, and iOS moves the lock screen's elapsed time on from the last one.
 */
export const tickerRuns = ({ playing, foreground, readers }: TickerInputs): boolean =>
  playing && foreground && readers > 0;

/** Calls `listener` whenever what the position is read from changes; returns its removal. */
export type Changes = (listener: () => void) => () => void;

/**
 * The live position for the screens that show it. It reads the position on a timer only while
 * `tickerRuns`, and once whenever its source says the position changed other than by time
 * passing while a reader shows it on screen, so a jump of a position that stands still shows at
 * once, whatever made it.
 */
export interface PositionTicker {
  /** Adds a reader, called with each new position; returns the function that removes it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The position last read, in whole milliseconds. */
  readonly read: () => number;
  /** Tells whether the position moves and whether the app is on screen. */
  readonly update: (inputs: Omit<TickerInputs, "readers">) => void;
  /** Says the position may have changed other than by time passing, as `changes` do. */
  readonly changed: () => void;
}

/**
 * A `PositionTicker` over `source`, read every `everyMs` while `tickerRuns`, and once on each of
 * `changes`, which it hears only while a reader is mounted.
 */
export const positionTicker = (
  source: () => number,
  changes: ReadonlyArray<Changes>,
  everyMs: number,
): PositionTicker => {
  const listeners = new Set<() => void>();
  let inputs: Omit<TickerInputs, "readers"> = { playing: false, foreground: false };
  let positionMs = Math.round(source());
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopChanges: ReadonlyArray<() => void> = [];

  const readAgain = (): void => {
    const next = Math.round(source());

    if (next === positionMs) return;
    positionMs = next;

    for (const listener of listeners) listener();
  };

  // A running timer reads it within `everyMs` anyway; off screen, coming back reads it.
  const changed = (): void => {
    if (listeners.size > 0 && inputs.foreground && timer === undefined) readAgain();
  };

  const follow = (): void => {
    const runs = tickerRuns({ ...inputs, readers: listeners.size });

    if (runs === (timer !== undefined)) return;

    if (runs) {
      timer = setInterval(readAgain, everyMs);

      return;
    }

    clearInterval(timer);
    timer = undefined;
  };

  return {
    subscribe: (listener) => {
      if (listeners.size === 0) stopChanges = changes.map((change) => change(changed));
      listeners.add(listener);
      readAgain();
      follow();

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) {
          for (const stop of stopChanges) stop();
          stopChanges = [];
        }

        follow();
      };
    },
    read: () => positionMs,
    update: (next) => {
      inputs = next;
      readAgain();
      follow();
    },
    changed,
  };
};

/** This phone's player, as the shown position reads it. */
export interface HerePosition {
  /** Where its song stands now, in milliseconds. */
  readonly positionMs: () => number;
  /** Tells after each change of what it shows, such as another song or a seek. */
  readonly subscribe: Changes;
}

/** The person's other devices' last reports, as the shown position reads them. */
export interface DevicePositions {
  readonly playbackOf: (deviceId: string) => DevicePlayback | null;
  /** The server's time now, which a report's position anchor is in. */
  readonly serverNow: () => number;
}

/** The device the screens follow while nothing plays here, and its song's length. */
interface Followed {
  readonly deviceId: string;
  /** Where a report's projection stops: the song's length, or 0 when unknown. */
  readonly durationMs: number;
}

/** The position the screens show, and what tells it which device they follow. */
export interface ShownPosition {
  /** The position now, fresh on every call, for animation frames. */
  readonly read: () => number;
  readonly ticker: PositionTicker;
  /**
   * Sets the device the screens follow, or null for this phone; the player calls it whenever what
   * it shows changes.
   */
  readonly follow: (followed: Followed | null) => void;
}

/**
 * The position the screens show: the followed device's last report projected to now while it has
 * one, else this phone's player. Its ticker reads again whenever the player shows something new
 * and whenever what the screens show changes.
 */
export const showPosition = (
  here: HerePosition,
  devices: DevicePositions,
  everyMs: number,
): ShownPosition => {
  let followed: Followed | null = null;

  const read = (): number => {
    const playback = followed === null ? null : devices.playbackOf(followed.deviceId);

    if (playback === null || followed === null) return here.positionMs();

    return devicePosition(playback, devices.serverNow(), followed.durationMs);
  };

  const ticker = positionTicker(read, [here.subscribe], everyMs);

  return {
    read,
    ticker,
    follow: (next) => {
      followed = next;
      ticker.changed();
    },
  };
};
