import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SLEEP_FADE_MS,
  SLEEP_TIMER_OFF,
  SleepTimer,
  customSleepMinutes,
  formatSleepTimeLeft,
  setSleepTimer,
  sleepHoldsAutoplay,
  sleepLetsScreenOff,
  sleepPausesPlayback,
  sleepTickMs,
  sleepTimeLeftMs,
  sleepTimerRuns,
  sleepVolume,
  stepSleepTimer,
} from "./sleep-timer";
import type { SleepReading } from "./sleep-timer";
import { EpochMillis } from "./units";

const NOW = 1_760_000_000_000;

const MINUTE = 60_000;

const EPISODE = "title:9:episode:2";

const NEXT = "title:9:episode:3";

const at = (ms: number): EpochMillis => EpochMillis.make(NOW + ms);

const reading = (overrides: Partial<SleepReading> = {}): SleepReading => ({
  itemKey: EPISODE,
  leftMs: 20 * MINUTE,
  playing: true,
  ...overrides,
});

const SLEPT = SleepTimer.Slept({ heardPause: false });

/**
 * A run of steps: how far the clock moves, never back, in seconds or minutes so runs both cross a
 * short timer's end in small steps and jump past it, and what the player reports.
 */
const steps = fc.array(
  fc.record({
    advanceMs: fc.oneof(
      fc.integer({ min: 0, max: 15_000 }),
      fc.integer({ min: 0, max: 2 * MINUTE }),
    ),
    reading: fc.option(
      fc.record({
        itemKey: fc.constantFrom(EPISODE, NEXT),
        leftMs: fc.option(fc.integer({ min: 0, max: 60 * MINUTE })),
        playing: fc.boolean(),
      }),
    ),
  }),
  { maxLength: 40 },
);

describe("a timer of minutes", () => {
  const timer = setSleepTimer({ kind: "after", minutes: 15 }, at(0));

  it("runs out the minutes after it was set", () => {
    expect(timer).toStrictEqual(SleepTimer.Counting({ endsAt: at(15 * MINUTE) }));
    expect(sleepTimeLeftMs(timer, null, at(0))).toBe(15 * MINUTE);
    expect(sleepTimeLeftMs(timer, null, at(15 * MINUTE - 1_000))).toBe(1_000);
    expect(stepSleepTimer(timer, reading(), at(15 * MINUTE - 1))).toBe(timer);
  });

  it("then fades for the fade's length and sleeps", () => {
    const fading = stepSleepTimer(timer, reading(), at(15 * MINUTE));

    expect(fading).toStrictEqual(SleepTimer.Fading({ pausesAt: at(15 * MINUTE + SLEEP_FADE_MS) }));
    expect(sleepTimeLeftMs(fading, null, at(15 * MINUTE))).toBe(0);
    expect(sleepVolume(fading, at(15 * MINUTE))).toBe(1);
    expect(sleepVolume(fading, at(15 * MINUTE + SLEEP_FADE_MS / 2))).toBe(0.5);
    expect(stepSleepTimer(fading, reading(), at(15 * MINUTE + SLEEP_FADE_MS - 1))).toBe(fading);

    const slept = stepSleepTimer(fading, reading(), at(15 * MINUTE + SLEEP_FADE_MS));

    expect(slept).toStrictEqual(SLEPT);
    expect(sleepPausesPlayback(fading)).toBe(false);
    expect(sleepPausesPlayback(slept)).toBe(true);
    expect(sleepVolume(slept, at(15 * MINUTE + SLEEP_FADE_MS))).toBe(1);
    expect(sleepLetsScreenOff(slept)).toBe(true);
  });

  it("lands in the fade or asleep when the clock jumps past its end, never counting", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 24 * 60 }),
        fc.integer({ min: 0, max: 3 * SLEEP_FADE_MS }),
        (minutes, pastMs) => {
          const endsAt = minutes * MINUTE;

          const stepped = stepSleepTimer(
            setSleepTimer({ kind: "after", minutes }, at(0)),
            null,
            at(endsAt + pastMs),
          );

          expect(stepped).toStrictEqual(
            pastMs < SLEEP_FADE_MS
              ? SleepTimer.Fading({ pausesAt: at(endsAt + SLEEP_FADE_MS) })
              : SLEPT,
          );
        },
      ),
    );
  });

  it("never shows more time left after a step", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), steps, (minutes, run) => {
        let now = at(0);
        let stepped = setSleepTimer({ kind: "after", minutes }, now);
        let left = sleepTimeLeftMs(stepped, null, now);

        for (const step of run) {
          now = EpochMillis.make(now + step.advanceMs);
          stepped = stepSleepTimer(stepped, step.reading, now);

          const next = sleepTimeLeftMs(stepped, step.reading, now);

          if (next !== null) {
            expect(left).not.toBeNull();
            expect(next).toBeLessThanOrEqual(left ?? 0);
          }

          left = next;
        }
      }),
    );
  });

  it("keeps counting through another episode, so autoplay carries it on", () => {
    expect(stepSleepTimer(timer, reading({ itemKey: NEXT }), at(MINUTE))).toBe(timer);
    expect(sleepHoldsAutoplay(timer, EPISODE)).toBe(false);
  });
});

describe("a timer to the end of an item", () => {
  const timer = setSleepTimer({ kind: "itemEnd", itemKey: EPISODE }, at(0));

  it("shows the item's time left and holds autoplay on that item only", () => {
    expect(sleepTimeLeftMs(timer, reading({ leftMs: 125_000 }), at(0))).toBe(125_000);
    expect(sleepTimeLeftMs(timer, reading({ leftMs: null }), at(0))).toBeNull();
    expect(sleepHoldsAutoplay(timer, EPISODE)).toBe(true);
    expect(sleepHoldsAutoplay(timer, NEXT)).toBe(false);
  });

  it("waits while more than the fade is left", () => {
    expect(stepSleepTimer(timer, reading({ leftMs: SLEEP_FADE_MS + 1 }), at(0))).toBe(timer);
    expect(stepSleepTimer(timer, reading({ leftMs: null }), at(0))).toBe(timer);
    expect(stepSleepTimer(timer, null, at(0))).toBe(timer);
  });

  it("fades until the item ends", () => {
    const fading = stepSleepTimer(timer, reading({ leftMs: 8_000 }), at(0));

    expect(fading).toStrictEqual(SleepTimer.Fading({ pausesAt: at(8_000) }));
    expect(sleepVolume(fading, at(0))).toBe(0.8);
    expect(stepSleepTimer(fading, null, at(8_000))).toStrictEqual(SLEPT);
  });

  it("sleeps at once when the item has ended", () => {
    expect(stepSleepTimer(timer, reading({ leftMs: 0, playing: false }), at(0))).toStrictEqual(
      SLEPT,
    );
  });

  it("ends when another item plays", () => {
    expect(stepSleepTimer(timer, reading({ itemKey: NEXT }), at(0))).toBe(SLEEP_TIMER_OFF);
  });
});

describe("after the timer paused playback", () => {
  it("holds autoplay and stops ticking", () => {
    expect(sleepHoldsAutoplay(SLEPT, EPISODE)).toBe(true);
    expect(sleepTickMs(SLEPT)).toBeNull();
    expect(sleepTimerRuns(SLEPT)).toBe(false);
    expect(sleepTimeLeftMs(SLEPT, reading(), at(0))).toBeNull();
  });

  it("keeps asking for the pause while the player still plays", () => {
    expect(stepSleepTimer(SLEPT, reading({ playing: true }), at(0))).toBe(SLEPT);
    expect(sleepPausesPlayback(SLEPT)).toBe(true);
  });

  it("ends when the viewer plays again after the pause", () => {
    const paused = stepSleepTimer(SLEPT, reading({ playing: false }), at(0));

    expect(paused).toStrictEqual(SleepTimer.Slept({ heardPause: true }));
    expect(sleepPausesPlayback(paused)).toBe(false);
    expect(sleepLetsScreenOff(paused)).toBe(true);
    expect(stepSleepTimer(paused, reading({ playing: false }), at(MINUTE))).toBe(paused);
    expect(stepSleepTimer(paused, reading({ playing: true }), at(2 * MINUTE))).toBe(
      SLEEP_TIMER_OFF,
    );
  });
});

describe("the volume during a fade", () => {
  it("stays between 0 and 1 and never rises", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: SLEEP_FADE_MS }),
        fc.integer({ min: -SLEEP_FADE_MS, max: 3 * SLEEP_FADE_MS }),
        fc.integer({ min: 0, max: 3 * SLEEP_FADE_MS }),
        (leftMs, sinceMs, laterMs) => {
          const fading = stepSleepTimer(
            setSleepTimer({ kind: "itemEnd", itemKey: EPISODE }, at(0)),
            reading({ leftMs }),
            at(0),
          );

          const first = sleepVolume(fading, at(sinceMs));
          const second = sleepVolume(fading, at(sinceMs + laterMs));

          expect(first).toBeGreaterThanOrEqual(0);
          expect(first).toBeLessThanOrEqual(1);
          expect(second).toBeLessThanOrEqual(first);
        },
      ),
    );
  });
});

describe("a timer that is off", () => {
  it("does nothing", () => {
    expect(stepSleepTimer(SLEEP_TIMER_OFF, reading(), at(0))).toBe(SLEEP_TIMER_OFF);
    expect(sleepTimeLeftMs(SLEEP_TIMER_OFF, reading(), at(0))).toBeNull();
    expect(sleepVolume(SLEEP_TIMER_OFF, at(0))).toBe(1);
    expect(sleepHoldsAutoplay(SLEEP_TIMER_OFF, EPISODE)).toBe(false);
    expect(sleepTickMs(SLEEP_TIMER_OFF)).toBeNull();
    expect(sleepTimerRuns(SLEEP_TIMER_OFF)).toBe(false);
  });
});

describe("customSleepMinutes", () => {
  it("takes hours and minutes up to 23:59", () => {
    expect(customSleepMinutes(1, 5)).toBe(65);
    expect(customSleepMinutes(0, 1)).toBe(1);
    expect(customSleepMinutes(23, 59)).toBe(23 * 60 + 59);
  });

  it("refuses no time, out of range, and fractions", () => {
    expect(customSleepMinutes(0, 0)).toBeNull();
    expect(customSleepMinutes(24, 0)).toBeNull();
    expect(customSleepMinutes(0, 60)).toBeNull();
    expect(customSleepMinutes(-1, 30)).toBeNull();
    expect(customSleepMinutes(0, 1.5)).toBeNull();
    expect(customSleepMinutes(Number.NaN, 10)).toBeNull();
  });
});

describe("formatSleepTimeLeft", () => {
  it("reads minutes and seconds, with hours when there are any", () => {
    expect(formatSleepTimeLeft(29 * MINUTE + 41_000)).toBe("29:41");
    expect(formatSleepTimeLeft(65 * MINUTE)).toBe("1:05:00");
    expect(formatSleepTimeLeft(9_000)).toBe("0:09");
  });

  it("rounds up, so it reads 0:00 only at the end", () => {
    expect(formatSleepTimeLeft(1)).toBe("0:01");
    expect(formatSleepTimeLeft(59_999)).toBe("1:00");
    expect(formatSleepTimeLeft(0)).toBe("0:00");
  });
});
