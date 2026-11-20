import { fixedValue } from "@media/ui/lib/live-value";
import type { LiveValue } from "@media/ui/lib/live-value";

import { bufferedAheadSeconds } from "./diagnostics";
import type { DiagnosedElement } from "./diagnostics";
import type { MediaElementPlayer } from "./media-element-player";

/** The element's events after which what the controls draw of it may have changed. */
const MEDIA_EVENTS = [
  "timeupdate",
  "play",
  "pause",
  "playing",
  "waiting",
  "seeking",
  "seeked",
  "progress",
  "volumechange",
  "ended",
  "loadeddata",
  "emptied",
] as const;

/** Moves of the position smaller than this keep the last one, so readers between events agree. */
const POSITION_TOLERANCE_SECONDS = 0.05;

const BUFFERED_TOLERANCE_SECONDS = 0.5;

/** The parts of a `<video>` element its progress reads. */
export type ProgressElement = DiagnosedElement &
  Pick<HTMLMediaElement, "addEventListener" | "removeEventListener">;

/** The parts of the element's player its progress reads. */
export type ProgressPlayer = Pick<MediaElementPlayer, "positionMs" | "subscribe">;

/** Where playback is and how far ahead it is buffered: values that move many times a second. */
export interface MediaProgress {
  /** Seconds played, holding a seek's target until it lands. */
  readonly position: LiveValue<number>;
  /** Seconds buffered ahead of the position. */
  readonly bufferedAhead: LiveValue<number>;
}

/** Progress while nothing plays. */
export const NO_PROGRESS: MediaProgress = { position: fixedValue(0), bufferedAhead: fixedValue(0) };

/**
 * Calls `onChange` after each of `element`'s media events and each of `player`'s own changes, such
 * as a seek it starts, until the returned function is called.
 */
export const followMedia = (
  element: ProgressElement,
  player: ProgressPlayer,
  onChange: () => void,
): (() => void) => {
  for (const type of MEDIA_EVENTS) element.addEventListener(type, onChange);

  const unsubscribe = player.subscribe(onChange);

  return () => {
    for (const type of MEDIA_EVENTS) element.removeEventListener(type, onChange);
    unsubscribe();
  };
};

const settled = (
  read: () => number,
  tolerance: number,
  subscribe: LiveValue<number>["subscribe"],
): LiveValue<number> => {
  let current = read();

  return {
    get: () => {
      const next = read();

      if (Math.abs(next - current) >= tolerance) current = next;

      return current;
    },
    subscribe,
  };
};

/** `element`'s position through `player`, and its buffer ahead, followed through its events. */
export const mediaProgress = (element: ProgressElement, player: ProgressPlayer): MediaProgress => {
  const subscribe = (onChange: () => void): (() => void) => followMedia(element, player, onChange);

  return {
    position: settled(() => player.positionMs() / 1000, POSITION_TOLERANCE_SECONDS, subscribe),
    bufferedAhead: settled(
      () => bufferedAheadSeconds(element),
      BUFFERED_TOLERANCE_SECONDS,
      subscribe,
    ),
  };
};
