import {
  SLEEP_TIMER_OFF,
  SleepTimer,
  setSleepTimer,
  sleepTickMs,
  sleepTimeLeftMs,
  sleepVolume,
  stepSleepTimer,
} from "@media/contracts/sleep-timer";
import type { SleepChoice, SleepReading } from "@media/contracts/sleep-timer";
import { EpochMillis } from "@media/contracts/units";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** A sleep timer kept above the player, so it outlives each episode's player. */
export interface SleepTimerControl {
  readonly timer: SleepTimer;
  /** How long until it runs out, for the button's label; null when none runs or it is unknown. */
  readonly leftMs: number | null;
  /** What scales the volume the viewer set: below 1 only while the sound fades. */
  readonly volume: number;
  readonly set: (choice: SleepChoice) => void;
  readonly cancel: () => void;
  /** What the player plays now; the player reports each change. */
  readonly report: (reading: SleepReading) => void;
}

interface SleepView {
  readonly timer: SleepTimer;
  readonly now: EpochMillis;
  readonly reading: SleepReading | null;
}

const wallClock = (): EpochMillis => EpochMillis.make(Date.now());

/**
 * The sleep timer of a watch page. It steps on each report and, while a timer runs, on a tick, so
 * its label counts down; leaving the page drops it, which cancels it.
 */
export function useSleepTimer(): SleepTimerControl {
  const [view, setView] = useState<SleepView>(() => ({
    timer: SLEEP_TIMER_OFF,
    now: wallClock(),
    reading: null,
  }));

  const latest = useRef<SleepReading | null>(null);

  const tickMs = sleepTickMs(view.timer);

  useEffect(() => {
    if (tickMs === null) return undefined;

    const timer = setInterval(() => {
      const now = wallClock();
      const reading = latest.current;

      setView((current) => ({ timer: stepSleepTimer(current.timer, reading, now), now, reading }));
    }, tickMs);

    return () => clearInterval(timer);
  }, [tickMs]);

  const set = useCallback((choice: SleepChoice) => {
    const now = wallClock();

    setView({ timer: setSleepTimer(choice, now), now, reading: latest.current });
  }, []);

  const cancel = useCallback(() => {
    setView((current) =>
      SleepTimer.$is("Off")(current.timer) ? current : { ...current, timer: SLEEP_TIMER_OFF },
    );
  }, []);

  const report = useCallback((reading: SleepReading) => {
    latest.current = reading;

    const now = wallClock();

    setView((current) => {
      const timer = stepSleepTimer(current.timer, reading, now);

      return timer === current.timer ? current : { timer, now, reading };
    });
  }, []);

  return useMemo(
    () => ({
      timer: view.timer,
      leftMs: sleepTimeLeftMs(view.timer, view.reading, view.now),
      volume: sleepVolume(view.timer, view.now),
      set,
      cancel,
      report,
    }),
    [view, set, cancel, report],
  );
}
