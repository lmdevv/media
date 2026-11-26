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

/** The live position for the screens that show it, read on a timer only while `tickerRuns`. */
export interface PositionTicker {
  /** Adds a reader, called with each new position; returns the function that removes it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The position last read, in whole milliseconds. */
  readonly read: () => number;
  /** Tells whether the position moves and whether the app is on screen. */
  readonly update: (inputs: Omit<TickerInputs, "readers">) => void;
  /** Reads the position again now, as after a seek, another song, or a device's new report. */
  readonly refresh: () => void;
}

/** A `PositionTicker` over `source`, read every `everyMs` while `tickerRuns`. */
export const positionTicker = (source: () => number, everyMs: number): PositionTicker => {
  const listeners = new Set<() => void>();
  let inputs: Omit<TickerInputs, "readers"> = { playing: false, foreground: false };
  let positionMs = Math.round(source());
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = (): void => {
    const next = Math.round(source());

    if (next === positionMs) return;
    positionMs = next;

    for (const listener of listeners) listener();
  };

  const follow = (): void => {
    const runs = tickerRuns({ ...inputs, readers: listeners.size });

    if (runs === (timer !== undefined)) return;

    if (runs) {
      timer = setInterval(refresh, everyMs);

      return;
    }

    clearInterval(timer);
    timer = undefined;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      refresh();
      follow();

      return () => {
        listeners.delete(listener);
        follow();
      };
    },
    read: () => positionMs,
    update: (next) => {
      inputs = next;
      refresh();
      follow();
    },
    refresh,
  };
};
