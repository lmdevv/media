import type { EngineEvent, PlayerEngine } from "../src/engine";
import type { Player } from "../src/react";
import type { GapAnalysis } from "../src/testing/gap-analysis";

/** An engine event and when the page saw it (`performance.now()`). */
export type TimedEvent = EngineEvent & { readonly at: number };

interface GapMeasurement {
  readonly longestGapMs: number;
  readonly soundMs: number;
}

interface EngineHarness {
  readonly engine: PlayerEngine;
  readonly events: Array<TimedEvent>;
  readonly load: (
    file: string,
    startMs: number,
    autoplay: boolean,
    durationMs?: number,
  ) => Promise<void>;
  readonly preload: (file: string | null) => void;
  readonly gap: () => Promise<GapMeasurement>;
  readonly buffered: () => ReadonlyArray<readonly [number, number]>;
  readonly resetGap: () => void;
  readonly record: () => void;
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
    audioElements?: Set<HTMLMediaElement>;
  }
}
