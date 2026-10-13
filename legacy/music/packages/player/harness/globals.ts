/** Globals the harness pages expose to Playwright. */
import type { EngineEvent, PlayerEngine } from "../src/engine";
import type { Player } from "../src/react";
import type { GapAnalysis } from "../src/testing/gap-analysis";

/** An engine event and when the page saw it (`performance.now()`). */
export type TimedEvent = EngineEvent & { readonly at: number };

/** What the capture worklet measured in the audio the engine produced. */
interface GapMeasurement {
  /** Longest silence between two sounds, in milliseconds. */
  readonly longestGapMs: number;
  /** Milliseconds of output that carried sound. */
  readonly soundMs: number;
}

/** The engine test page. */
interface EngineHarness {
  readonly engine: PlayerEngine;
  readonly events: Array<TimedEvent>;
  /** Loads a generated fixture into the engine; `durationMs` defaults to the tones' 3 s. */
  readonly load: (
    file: string,
    startMs: number,
    autoplay: boolean,
    durationMs?: number,
  ) => Promise<void>;
  /** Preloads a generated fixture, or clears the preload. */
  readonly preload: (file: string | null) => void;
  readonly gap: () => Promise<GapMeasurement>;
  readonly resetGap: () => void;
  /** Starts recording the first output channel, dropping any earlier recording. */
  readonly record: () => void;
  /** Stops recording and analyzes it as the gapless tone cut at `cuts` (see `analyzeTone`). */
  readonly analyze: (
    cuts: ReadonlyArray<number>,
    frequency: number,
    sourceRate: number,
  ) => Promise<GapAnalysis>;
}

declare global {
  interface Window {
    harness?: EngineHarness;
    player?: Player;
    /** Every audio element the session page's engine created. */
    audioElements?: Set<HTMLMediaElement>;
  }
}
