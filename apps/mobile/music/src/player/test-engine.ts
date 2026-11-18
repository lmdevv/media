import type { EngineEvent, EngineSource, PlayerEngine } from "@media/player/engine";

/** One load the engine was asked for. */
export interface Load {
  readonly url: string;
  readonly startMs: number;
}

/** An engine whose stream can drop, as when the network or the server goes away. */
export interface TestEngine extends PlayerEngine {
  /** The song loaded stops with a network error. */
  readonly dropStream: () => void;
  /** The song loaded plays to its end. */
  readonly end: () => void;
}

/** An engine that plays at once, as a copy on the phone does, and records every load. */
export const instantEngine = (loads: Array<Load>): TestEngine => {
  const listeners = new Set<(event: EngineEvent) => void>();
  let positionMs = 0;
  let playing = false;
  let loaded: EngineSource | null = null;

  const emit = (event: EngineEvent): void => {
    if (event.type === "time") positionMs = event.positionMs;

    if (event.type === "playing") playing = true;
    else if (event.type === "paused") playing = false;

    for (const listener of listeners) listener(event);
  };

  return {
    dropStream: () => {
      emit({ type: "error", reason: "network", message: "The network dropped" });
    },
    end: () => {
      playing = false;
      emit({ type: "ended" });
    },
    samplePlayback: () => ({ positionMs, playing }),
    load: async (source, startMs, autoplay) => {
      loads.push({ url: source.url, startMs });
      loaded = source;
      positionMs = startMs;
      emit({ type: autoplay ? "playing" : "paused" });
    },
    preload: () => {},
    play: async () => {
      if (loaded !== null) emit({ type: "playing" });
    },
    pause: () => {
      emit({ type: "paused" });
    },
    seek: (target) => {
      emit({ type: "time", positionMs: target });
    },
    setVolume: () => {},
    unload: () => {
      loaded = null;
      positionMs = 0;
      playing = false;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** Lets the controller's loads and the engine's answers run, a few macrotasks deep. */
export const settle = async (turns = 5): Promise<void> => {
  if (turns === 0) return;

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await settle(turns - 1);
};
