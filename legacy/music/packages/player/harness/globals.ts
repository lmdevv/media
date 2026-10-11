/** Globals the harness pages expose to Playwright. */
import type { EngineEvent, PlayerEngine } from "../src/engine";
import type { Player } from "../src/react";

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
  /** Loads a generated fixture (3 s tones) into the engine. */
  readonly load: (file: string, startMs: number, autoplay: boolean) => Promise<void>;
  /** Preloads a generated fixture, or clears the preload. */
  readonly preload: (file: string | null) => void;
  readonly gap: () => Promise<GapMeasurement>;
  readonly resetGap: () => void;
}

declare global {
  interface Window {
    harness?: EngineHarness;
    player?: Player;
    /** Every audio element the session page's engine created. */
    audioElements?: Set<HTMLMediaElement>;
  }
}
