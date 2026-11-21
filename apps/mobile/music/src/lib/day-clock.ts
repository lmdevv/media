import { dayOf } from "./history";

const nextDayOf = (day: number): number => {
  const date = new Date(day);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
};

/** The local calendar day it is, as an external store that tells its listeners when it changes. */
export interface DayClock {
  /** The start of the current local day. */
  readonly read: () => number;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the time again, for a phone that slept through midnight with the app in the background. */
  readonly refresh: () => void;
}

/** A {@link DayClock} over `now`, which reads it again at each local midnight while anyone listens. */
export const dayClock = (now: () => number): DayClock => {
  const listeners = new Set<() => void>();
  let today = dayOf(now());
  let midnight: ReturnType<typeof setTimeout> | undefined;

  const refresh = (): void => {
    const at = now();
    const day = dayOf(at);

    clearTimeout(midnight);
    midnight = listeners.size === 0 ? undefined : setTimeout(refresh, nextDayOf(day) - at);

    if (day === today) return;

    today = day;

    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    refresh();

    return () => {
      listeners.delete(listener);

      if (listeners.size === 0) clearTimeout(midnight);
    };
  };

  return { read: () => today, subscribe, refresh };
};
