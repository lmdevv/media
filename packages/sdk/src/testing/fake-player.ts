import { Clock, Effect } from "effect";

import type { PlayerEvent, PlayerPort } from "../room-sync/player-port";

/** A fake player plus the controls a test uses to act as the viewer or the network. */
interface FakePlayer extends PlayerPort {
  /** The viewer presses play. */
  readonly userPlay: () => void;
  /** The viewer presses pause. */
  readonly userPause: () => void;
  /** The viewer scrubs to `positionMs`. */
  readonly userSeek: (positionMs: number) => void;
  /** The network stalls playback until `recover`. */
  readonly stall: () => void;
  readonly recover: () => void;
  /** Makes `play` reject, as browsers do before a user gesture. */
  readonly blockAutoplay: (blocked: boolean) => void;
}

/** Creates a paused player at `positionMs`. */
export const makeFakePlayer = Effect.fn("FakePlayer.make")(function* (positionMs: number) {
  const clock = yield* Clock.Clock;
  const listeners = new Set<(event: PlayerEvent) => void>();
  let base = positionMs;
  let since = clock.currentTimeMillisUnsafe();
  let paused = true;
  let stalled = false;
  let rate = 1;
  let autoplayBlocked = false;

  const position = (): number =>
    paused || stalled ? base : base + (clock.currentTimeMillisUnsafe() - since) * rate;

  const settle = (): void => {
    base = position();
    since = clock.currentTimeMillisUnsafe();
  };

  const emit = (event: PlayerEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const start = (): void => {
    if (!paused) return;
    settle();
    paused = false;
    emit("playing");
  };

  const stop = (): void => {
    if (paused) return;
    settle();
    paused = true;
    emit("paused");
  };

  const seekTo = (target: number): void => {
    settle();
    base = Math.max(0, target);
    emit("seeked");
  };

  const player: FakePlayer = {
    positionMs: position,
    isPaused: () => paused,
    isBuffering: () => stalled && !paused,
    playbackRate: () => rate,
    setPlaybackRate: (next) => {
      settle();
      rate = next;
    },
    seek: seekTo,
    play: () => {
      if (autoplayBlocked) return Promise.reject(new Error("NotAllowedError"));
      start();

      return Promise.resolve();
    },
    pause: stop,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    userPlay: () => {
      autoplayBlocked = false;
      start();
    },
    userPause: stop,
    userSeek: seekTo,
    stall: () => {
      settle();
      stalled = true;

      if (!paused) emit("waiting");
    },
    recover: () => {
      settle();
      stalled = false;

      if (!paused) emit("playing");
    },
    blockAutoplay: (blocked) => {
      autoplayBlocked = blocked;
    },
  };

  return player;
});
