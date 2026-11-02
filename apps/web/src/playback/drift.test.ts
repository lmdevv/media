import {
  DRIFT_WINDOW_SAMPLES,
  MAX_DRIFT_MS,
  PlayerObservation,
} from "@movies/contracts/diagnostics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriftElement, DriftEvent, PresentedFrame } from "./drift";
import { sampleDrift, videoAheadMs } from "./drift";

const HAVE_ENOUGH_DATA = 4;

type FrameCallback = (now: number, metadata: PresentedFrame) => void;

class FakeVideo implements DriftElement {
  paused = false;
  seeking = false;
  readyState = HAVE_ENOUGH_DATA;
  currentTime = 30;
  playbackRate = 1;
  /** The media time of the next frame shown, relative to the media clock, in seconds. */
  frameAhead = -0.04;
  readonly #callbacks = new Map<number, FrameCallback>();
  readonly #listeners = new Map<DriftEvent, Set<() => void>>();
  #handles = 0;

  requestVideoFrameCallback = (callback: FrameCallback): number => {
    this.#handles += 1;
    this.#callbacks.set(this.#handles, callback);

    return this.#handles;
  };

  cancelVideoFrameCallback = (handle: number): void => {
    this.#callbacks.delete(handle);
  };

  addEventListener(type: DriftEvent, listener: () => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();

    this.#listeners.set(type, listeners.add(listener));
  }

  removeEventListener(type: DriftEvent, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  fire(type: DriftEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }

  listening(): number {
    return [...this.#listeners.values()].reduce((total, each) => total + each.size, 0);
  }

  presentFrame(): void {
    const pending = [...this.#callbacks.values()];

    this.#callbacks.clear();

    for (const callback of pending) {
      const now = performance.now();

      callback(now, { mediaTime: this.currentTime + this.frameAhead, expectedDisplayTime: now });
    }
  }

  requested(): number {
    return this.#callbacks.size;
  }
}

const SAMPLE_EVERY_MS = 10_000;

const start = (element: DriftElement) => {
  const observed: Array<PlayerObservation> = [];
  const stop = sampleDrift(element, (observation) => observed.push(observation));

  return { observed, stop };
};

const sample = (element: FakeVideo, aheadMs: number): void => {
  vi.advanceTimersByTime(SAMPLE_EVERY_MS);
  element.frameAhead = aheadMs / 1000;
  element.presentFrame();
};

const drift = (samples: number, medianMs: number, worstMs: number) =>
  PlayerObservation.cases.DriftSampled.make({ samples, medianMs, worstMs });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("audio/video drift", () => {
  it("measures how far the frame shown is ahead of the media clock when it shows", () => {
    expect(
      videoAheadMs(
        { mediaTime: 30.04, expectedDisplayTime: 1_016 },
        { currentTime: 30, playbackRate: 1, performanceNow: 1_000 },
      ),
    ).toBe(24);
    expect(
      videoAheadMs(
        { mediaTime: 29.9, expectedDisplayTime: 1_000 },
        { currentTime: 30, playbackRate: 2, performanceNow: 1_000 },
      ),
    ).toBe(-100);
    expect(
      videoAheadMs(
        { mediaTime: 30.5, expectedDisplayTime: 1_250 },
        { currentTime: 30, playbackRate: 2, performanceNow: 1_000 },
      ),
    ).toBe(0);
  });

  it("holds a sample to the range the service accepts", () => {
    const clock = { currentTime: 0, playbackRate: 1, performanceNow: 0 };

    expect(videoAheadMs({ mediaTime: 600, expectedDisplayTime: 0 }, clock)).toBe(MAX_DRIFT_MS);
    expect(
      videoAheadMs({ mediaTime: 0, expectedDisplayTime: 0 }, { ...clock, currentTime: 600 }),
    ).toBe(-MAX_DRIFT_MS);
  });

  it("asks for one frame every ten seconds while the element plays, and stops when told", () => {
    const element = new FakeVideo();
    const { stop } = start(element);

    vi.advanceTimersByTime(SAMPLE_EVERY_MS - 1);
    expect(element.requested()).toBe(0);

    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(SAMPLE_EVERY_MS);
    expect(element.requested()).toBe(1);
    element.presentFrame();

    element.paused = true;
    vi.advanceTimersByTime(SAMPLE_EVERY_MS);
    element.paused = false;
    element.seeking = true;
    vi.advanceTimersByTime(SAMPLE_EVERY_MS);
    element.seeking = false;
    element.readyState = 2;
    vi.advanceTimersByTime(SAMPLE_EVERY_MS);
    expect(element.requested()).toBe(0);

    element.readyState = HAVE_ENOUGH_DATA;
    vi.advanceTimersByTime(SAMPLE_EVERY_MS);
    expect(element.requested()).toBe(1);

    stop();
    expect(element.requested()).toBe(0);
    vi.advanceTimersByTime(3 * SAMPLE_EVERY_MS);
    expect(element.requested()).toBe(0);
  });

  it("sends one summary per window of samples, and what it holds when it stops", () => {
    const element = new FakeVideo();
    const { observed, stop } = start(element);
    const window = [-40, 10, -20, 80, -30, 0];

    expect(window).toHaveLength(DRIFT_WINDOW_SAMPLES);

    for (const [index, aheadMs] of window.entries()) {
      sample(element, aheadMs);
      expect(observed).toHaveLength(index === window.length - 1 ? 1 : 0);
    }

    expect(observed).toStrictEqual([drift(6, -10, 80)]);

    sample(element, -120);
    sample(element, 40);
    expect(observed).toHaveLength(1);

    stop();
    expect(observed).toStrictEqual([drift(6, -10, 80), drift(2, -40, -120)]);
  });

  it("sends nothing when it stops without a sample", () => {
    const element = new FakeVideo();
    const { observed, stop } = start(element);

    vi.advanceTimersByTime(SAMPLE_EVERY_MS - 1);
    stop();

    expect(observed).toStrictEqual([]);
  });

  it.each(["pause", "seeking", "waiting"] as const)(
    "drops the frame it asked for when the element fires %s",
    (event) => {
      const element = new FakeVideo();
      const { observed, stop } = start(element);

      vi.advanceTimersByTime(SAMPLE_EVERY_MS);
      expect(element.requested()).toBe(1);

      element.fire(event);
      expect(element.requested()).toBe(0);
      element.frameAhead = 5;
      element.presentFrame();
      stop();

      expect(observed).toStrictEqual([]);
    },
  );

  it.each(["playing", "seeked"] as const)(
    "takes no sample for two seconds after the element fires %s",
    (event) => {
      const element = new FakeVideo();
      const { observed, stop } = start(element);

      vi.advanceTimersByTime(SAMPLE_EVERY_MS);
      element.fire(event);
      element.frameAhead = 5;
      element.presentFrame();

      vi.advanceTimersByTime(SAMPLE_EVERY_MS - 500);
      element.fire(event);
      vi.advanceTimersByTime(500);
      expect(element.requested(), "a tick inside the settle window asks for no frame").toBe(0);

      vi.advanceTimersByTime(SAMPLE_EVERY_MS);
      expect(element.requested()).toBe(1);
      element.frameAhead = -0.03;
      element.presentFrame();
      stop();

      expect(observed).toStrictEqual([drift(1, -30, -30)]);
    },
  );

  it("stops listening to the element when stopped", () => {
    const element = new FakeVideo();
    const { stop } = start(element);

    expect(element.listening()).toBeGreaterThan(0);
    stop();
    expect(element.listening()).toBe(0);
  });

  it("sends nothing where the browser has no video frame callbacks", () => {
    const element: DriftElement = {
      paused: false,
      seeking: false,
      readyState: HAVE_ENOUGH_DATA,
      currentTime: 30,
      playbackRate: 1,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };

    const { observed, stop } = start(element);

    vi.advanceTimersByTime(6 * SAMPLE_EVERY_MS);
    stop();

    expect(observed).toStrictEqual([]);
  });
});
