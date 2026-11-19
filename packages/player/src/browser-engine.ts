import type { PlayerEngine } from "./engine";
import { HtmlAudioEngine } from "./html-audio-engine";
import { MseEngine } from "./mse-engine";
import type { EngineFactory } from "./playback-controller";

/** Browser audio with the gapless engine where supported, or a host-supplied fixed engine. */
export const browserEngines = (engine?: () => PlayerEngine): EngineFactory => {
  if (engine !== undefined) return { mse: null, create: engine };

  return {
    mse: MseEngine.detectSupport(),
    create: (kind) => (kind === "mse" ? new MseEngine(new Audio()) : new HtmlAudioEngine()),
  };
};
