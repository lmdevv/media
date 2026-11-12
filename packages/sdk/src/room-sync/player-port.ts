/** Something that happened on a player, from user input, the network, or the engine itself. */
export type PlayerEvent =
  /** Playback started or resumed after a pause or a stall. */
  | "playing"
  | "paused"
  /** A seek finished. */
  | "seeked"
  /** Playback stalled waiting for data. */
  | "waiting"
  | "ended";

/**
 * A media player as the room engine sees it. Getters return the state at the moment of the call;
 * `subscribe` reports events as they happen and returns a function that stops reporting.
 *
 * A web adapter maps `currentTime * 1000` to `positionMs`, `readyState < HAVE_FUTURE_DATA` on a
 * playing element to `isBuffering`, and the `playing`, `pause`, `seeked`, `waiting`, and `ended`
 * events to `PlayerEvent`.
 */
export interface PlayerPort {
  /** Position in the media, in milliseconds. */
  readonly positionMs: () => number;
  readonly isPaused: () => boolean;
  /** Stalled waiting for data while meant to be playing. */
  readonly isBuffering: () => boolean;
  readonly playbackRate: () => number;
  readonly setPlaybackRate: (rate: number) => void;
  readonly seek: (positionMs: number) => void;
  /** Starts playback. Rejects when the platform blocks playback until the user interacts. */
  readonly play: () => Promise<void>;
  readonly pause: () => void;
  readonly subscribe: (listener: (event: PlayerEvent) => void) => () => void;
  /**
   * The player plays at normal speed only, such as a cast device: rate changes do nothing, so the
   * room engine corrects drift by seeking. Absent means the rate can change.
   */
  readonly fixedRate?: boolean;
}
