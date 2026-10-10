/**
 * The audio output seam. The provider decides what plays; an engine only turns URLs into sound.
 * Engines: MSE gapless (fragmented MP4 appended into one SourceBuffer) and an HTML audio
 * fallback for browsers that fail the MSE checks.
 */

/** One playable source: a signed stream URL plus what the engine needs to schedule it. */
export interface EngineSource {
  readonly key: string;
  readonly url: string;
  readonly durationMs: number;
}

export type EngineEvent =
  | { readonly type: "playing" }
  | { readonly type: "paused" }
  | { readonly type: "waiting" }
  | { readonly type: "time"; readonly positionMs: number }
  /** The current source finished and the engine moved to the preloaded one without a gap. */
  | { readonly type: "advanced"; readonly key: string }
  /** The current source finished and nothing was preloaded. */
  | { readonly type: "ended" }
  | { readonly type: "error"; readonly message: string };

export interface PlayerEngine {
  /** Replaces whatever is loaded and starts at `startMs`. Resolves once playback can begin. */
  load(source: EngineSource, startMs: number, autoplay: boolean): Promise<void>;
  /** Queues the next source so it starts without a gap when the current one ends. */
  preload(source: EngineSource | null): void;
  play(): Promise<void>;
  pause(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  /** Stops output and releases the audio element and buffers. */
  unload(): void;
  subscribe(listener: (event: EngineEvent) => void): () => void;
}
