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

/** Events after which the element rests where it is, so its position is taken exactly. */
const EXACT_EVENTS: ReadonlySet<string> = new Set(["pause", "seeked", "ended", "emptied"]);

/** A reading kept until a new one moves past `tolerance`, or is taken exactly. */
const settledReading = (read: () => number, tolerance: number) => {
  let current = read();

  return {
    current: () => current,
    /** Takes a new reading, and answers whether it changed the kept one. */
    take: (exact: boolean): boolean => {
      const next = read();

      if (next === current || (!exact && Math.abs(next - current) < tolerance)) return false;

      current = next;

      return true;
    },
  };
};

/**
 * `element`'s position through `player`, and its buffer ahead. While followed, both come from one
 * set of listeners on the element and the player, and each answers the same value between the
 * events that change it; unfollowed, each read takes a new reading.
 */
export const mediaProgress = (element: ProgressElement, player: ProgressPlayer): MediaProgress => {
  const position = settledReading(() => player.positionMs() / 1000, POSITION_TOLERANCE_SECONDS);
  const buffered = settledReading(() => bufferedAheadSeconds(element), BUFFERED_TOLERANCE_SECONDS);
  const followers = new Set<() => void>();
  let stopListening: (() => void) | null = null;

  const update = (exact: boolean): void => {
    const moved = position.take(exact);
    const grew = buffered.take(exact);

    if (!moved && !grew) return;

    for (const follower of followers) follower();
  };

  const onElementEvent = (event: Event): void => update(EXACT_EVENTS.has(event.type));
  const onPlayerChange = (): void => update(true);

  const subscribe = (onChange: () => void): (() => void) => {
    followers.add(onChange);

    if (stopListening === null) {
      for (const type of MEDIA_EVENTS) element.addEventListener(type, onElementEvent);

      const unsubscribe = player.subscribe(onPlayerChange);

      stopListening = () => {
        for (const type of MEDIA_EVENTS) element.removeEventListener(type, onElementEvent);
        unsubscribe();
      };
    }

    return () => {
      followers.delete(onChange);

      if (followers.size > 0 || stopListening === null) return;

      stopListening();
      stopListening = null;
    };
  };

  const liveOf = (reading: ReturnType<typeof settledReading>): LiveValue<number> => ({
    get: () => {
      if (stopListening === null) reading.take(false);

      return reading.current();
    },
    subscribe,
  });

  return { position: liveOf(position), bufferedAhead: liveOf(buffered) };
};
