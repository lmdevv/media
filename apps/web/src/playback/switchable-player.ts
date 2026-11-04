import type { PlayerEvent, PlayerPort } from "@media/sdk/effect";

/** A player whose target can change while others listen to it. */
export class SwitchablePlayer implements PlayerPort {
  #target: PlayerPort;
  #unsubscribe: () => void;
  readonly #listeners = new Set<(event: PlayerEvent) => void>();

  /** Starts out as `target`. */
  constructor(target: PlayerPort) {
    this.#target = target;
    this.#unsubscribe = target.subscribe(this.#forward);
  }

  /** The player commands go to and events come from. */
  get target(): PlayerPort {
    return this.#target;
  }

  /**
   * Makes `target` the player from now on. Only its events reach listeners afterwards, so the
   * previous player pausing or emptying itself does not read as the session pausing.
   */
  switchTo(target: PlayerPort): void {
    if (target === this.#target) return;
    this.#unsubscribe();
    this.#target = target;
    this.#unsubscribe = target.subscribe(this.#forward);
  }

  readonly #forward = (event: PlayerEvent): void => {
    for (const listener of this.#listeners) listener(event);
  };

  /** Whether the current target plays at normal speed only. */
  get fixedRate(): boolean {
    return this.#target.fixedRate === true;
  }

  readonly positionMs = (): number => this.#target.positionMs();

  readonly isPaused = (): boolean => this.#target.isPaused();

  readonly isBuffering = (): boolean => this.#target.isBuffering();

  readonly playbackRate = (): number => this.#target.playbackRate();

  readonly setPlaybackRate = (rate: number): void => this.#target.setPlaybackRate(rate);

  readonly seek = (positionMs: number): void => this.#target.seek(positionMs);

  readonly play = (): Promise<void> => this.#target.play();

  readonly pause = (): void => this.#target.pause();

  readonly subscribe = (listener: (event: PlayerEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
}

/**
 * A player that stands still at `positionMs`, for the moment between one device letting go of a
 * session and the next taking it: it reports where playback was and emits nothing.
 */
export const heldPlayer = (positionMs: number, paused: boolean): PlayerPort => ({
  positionMs: () => positionMs,
  isPaused: () => paused,
  isBuffering: () => !paused,
  playbackRate: () => 1,
  setPlaybackRate: () => undefined,
  seek: () => undefined,
  play: () => Promise.resolve(),
  pause: () => undefined,
  subscribe: () => () => undefined,
});
