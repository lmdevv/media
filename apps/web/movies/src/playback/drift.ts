/**
 * A sample is accurate to about one frame. It cannot see timestamps already wrong in the stream:
 * a frame stamped late plays late and still lines up with the media clock.
 */
import {
  DRIFT_WINDOW_SAMPLES,
  MAX_DRIFT_MS,
  PlayerObservation,
  summarizeDrift,
} from "@media/contracts/diagnostics";
import { Array as Arr } from "effect";

import type { Observe } from "./stream-attachment";

/** What `requestVideoFrameCallback` says about the frame it presents. */
export interface PresentedFrame {
  /** The frame's media time, in seconds. */
  readonly mediaTime: number;
  /** When the frame shows, on the `performance.now()` clock. */
  readonly expectedDisplayTime: number;
}

/** The element's media clock, read at `performanceNow` on the `performance.now()` clock. */
export interface MediaClock {
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly performanceNow: number;
}

/** The element events that end a sample's frame or start a settle window. */
export type DriftEvent = "pause" | "seeking" | "waiting" | "playing" | "seeked";

export interface DriftElement {
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly requestVideoFrameCallback?: (
    callback: (now: number, metadata: PresentedFrame) => void,
  ) => number;
  readonly cancelVideoFrameCallback?: (handle: number) => void;
  addEventListener(type: DriftEvent, listener: () => void): void;
  removeEventListener(type: DriftEvent, listener: () => void): void;
}

const SAMPLE_INTERVAL_MS = 10_000;

const SETTLE_MS = 2_000;

const HAVE_FUTURE_DATA = 3;

export const videoAheadMs = (frame: PresentedFrame, clock: MediaClock): number => {
  const clockAtDisplay =
    clock.currentTime +
    ((frame.expectedDisplayTime - clock.performanceNow) / 1000) * clock.playbackRate;

  return Math.min(
    MAX_DRIFT_MS,
    Math.max(-MAX_DRIFT_MS, Math.round((frame.mediaTime - clockAtDisplay) * 1000)),
  );
};

const playing = (element: DriftElement): boolean =>
  !element.paused && !element.seeking && element.readyState >= HAVE_FUTURE_DATA;

/**
 * Samples `element`'s drift every 10 s while it plays and observes one `DriftSampled` per
 * `DRIFT_WINDOW_SAMPLES` samples, and what it holds when the returned function stops it. The first
 * frame after a pause, seek, or wait shows how playback resumed, not steady drift, so a sample
 * pending across one is dropped and none is taken for 2 s after playing or seeked.
 */
export const sampleDrift = (element: DriftElement, observe: Observe): (() => void) => {
  const { requestVideoFrameCallback, cancelVideoFrameCallback } = element;

  if (requestVideoFrameCallback === undefined) return () => undefined;
  let pending: number | null = null;
  let settling: ReturnType<typeof setTimeout> | undefined;
  let samples: Array<number> = [];

  const send = (): void => {
    if (!Arr.isArrayNonEmpty(samples)) return;
    observe(PlayerObservation.cases.DriftSampled.make(summarizeDrift(samples)));
    samples = [];
  };

  const drop = (): void => {
    if (pending !== null) cancelVideoFrameCallback?.call(element, pending);
    pending = null;
  };

  const settle = (): void => {
    drop();
    clearTimeout(settling);
    settling = setTimeout(() => {
      settling = undefined;
    }, SETTLE_MS);
  };

  const onFrame = (_now: number, frame: PresentedFrame): void => {
    pending = null;

    if (settling !== undefined || !playing(element)) return;

    const clock = {
      currentTime: element.currentTime,
      playbackRate: element.playbackRate,
      performanceNow: performance.now(),
    };

    const videoAhead = videoAheadMs(frame, clock);

    if (!Number.isFinite(videoAhead)) return;
    samples.push(videoAhead);

    if (samples.length >= DRIFT_WINDOW_SAMPLES) send();
  };

  const timer = setInterval(() => {
    if (pending === null && settling === undefined && playing(element)) {
      pending = requestVideoFrameCallback.call(element, onFrame);
    }
  }, SAMPLE_INTERVAL_MS);

  const listeners = [
    ["pause", drop],
    ["seeking", drop],
    ["waiting", drop],
    ["playing", settle],
    ["seeked", settle],
  ] as const satisfies ReadonlyArray<readonly [DriftEvent, () => void]>;

  for (const [type, listener] of listeners) element.addEventListener(type, listener);

  return () => {
    clearInterval(timer);
    clearTimeout(settling);

    for (const [type, listener] of listeners) element.removeEventListener(type, listener);
    drop();
    send();
  };
};
