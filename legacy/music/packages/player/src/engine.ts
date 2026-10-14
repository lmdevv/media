/**
 * The audio output seam. The provider decides what plays; an engine only turns URLs into sound.
 *
 * Engines:
 * - `MseEngine` (`mse-engine.ts`): fragmented MP4 (`fmp4-flac` / `fmp4-aac`) appended into one
 *   `SourceBuffer` with `timestampOffset` and encoder-delay trimming, for sample-accurate gapless
 *   playback. `load` resets the `MediaSource`, `preload` appends the next song's fragments after
 *   the current one, and the engine emits `advanced` when `currentTime` crosses the boundary.
 * - `HtmlAudioEngine` (`html-audio-engine.ts`): two `HTMLAudioElement`s, the next one preloaded and
 *   started from the `ended` event. Works everywhere; leaves a small gap between songs.
 *
 * The provider prefers `MseEngine` where MSE plays AAC in MP4 and falls back to HTML audio for
 * data saver, for browsers without MSE, and for the rest of the session after the MSE engine
 * fails to play a song.
 *
 * Engines never reject or throw for expected failures (network, decoding, autoplay policy); they
 * emit an `error` event with a `reason` and resolve.
 */

/** Which engine implementation plays the audio. */
export type EngineKind = "mse" | "html";

/** One playable source: a signed stream URL plus what the engine needs to schedule it. */
export interface EngineSource {
  readonly key: string;
  readonly url: string;
  readonly durationMs: number;
}

/**
 * Why an engine failed:
 * - `network`: the stream could not be fetched (offline, HTTP error, media service down).
 * - `decode`: the bytes arrived but could not be decoded.
 * - `unsupported`: the browser rejected the source; it may be an HTTP error page or an
 *   unplayable format, so check the media service before blaming the format.
 * - `expired`: the media service refused the stream's signed URL (`403`), which it does once
 *   the URL has expired; a fresh URL for the same song plays.
 * - `autoplay-blocked`: the browser refused to start audio without a user gesture.
 */
export type EngineErrorReason =
  | "network"
  | "decode"
  | "unsupported"
  | "expired"
  | "autoplay-blocked";

export type EngineEvent =
  | { readonly type: "playing" }
  | { readonly type: "paused" }
  | { readonly type: "waiting" }
  | { readonly type: "time"; readonly positionMs: number }
  /** The current source finished and the engine moved to the preloaded one without a gap. */
  | { readonly type: "advanced"; readonly key: string }
  /** The current source finished and nothing was preloaded. */
  | { readonly type: "ended" }
  | { readonly type: "error"; readonly message: string; readonly reason: EngineErrorReason };

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
  /**
   * Primes idle audio output from inside a user gesture (a tap or click), so a `play()` that
   * follows later without one is allowed. iOS Safari only lets an audio element start on its own
   * after it was started inside a gesture once. Does nothing to output that is loaded or playing.
   */
  unlock?(): void;
  subscribe(listener: (event: EngineEvent) => void): () => void;
}
