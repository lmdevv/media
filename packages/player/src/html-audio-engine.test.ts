import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineEvent, EngineSource } from "./engine";
import { HtmlAudioEngine } from "./html-audio-engine";
import type { AudioElement } from "./html-audio-engine";

const HAVE_NOTHING = 0;

const HAVE_ENOUGH_DATA = 4;

const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const unsupported = (message: string): MediaError => ({
  code: MEDIA_ERR_SRC_NOT_SUPPORTED,
  message,
  MEDIA_ERR_ABORTED: 1,
  MEDIA_ERR_NETWORK: 2,
  MEDIA_ERR_DECODE: 3,
  MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
});

/**
 * An audio element that loads and plays at once, and fails the URLs in `failing` the way a
 * browser does: `error` set, an `error` event after the load, and `play()` rejecting after it.
 */
class StandInAudio extends EventTarget implements AudioElement {
  readyState = HAVE_NOTHING;
  duration = Number.NaN;
  paused = true;
  seeking = false;
  ended = false;
  error: MediaError | null = null;
  currentTime = 0;
  preload: AudioElement["preload"] = "";
  src = "";
  volume = 1;
  readonly #failing: ReadonlySet<string>;

  constructor(failing: ReadonlySet<string>) {
    super();
    this.#failing = failing;
  }

  load(): void {
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.error = null;
    this.readyState = HAVE_NOTHING;

    if (this.src === "") return;

    if (this.#failing.has(this.src)) {
      this.error = unsupported(`No audio at ${this.src}`);
      this.#later("error");

      return;
    }

    this.readyState = HAVE_ENOUGH_DATA;
    this.duration = 200;
    this.#later("loadedmetadata");
    this.#later("canplay");
  }

  play(): Promise<void> {
    if (this.error !== null || this.src === "") {
      return Promise.reject(new DOMException("No supported source", "NotSupportedError"));
    }

    this.paused = false;
    this.dispatchEvent(new Event("playing"));

    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  /** Plays to the end of the stream. */
  finish(): void {
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }

  #later(type: string): void {
    queueMicrotask(() => {
      this.dispatchEvent(new Event(type));
    });
  }
}

const source = (key: string): EngineSource => ({
  key,
  url: `http://media.test/stream/${key}`,
  durationMs: 200_000,
  finished: false,
});

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const setup = () => {
  const failing = new Set<string>();
  const elements: Array<StandInAudio> = [];

  const engine = new HtmlAudioEngine(() => {
    const element = new StandInAudio(failing);

    elements.push(element);

    return element;
  });

  const events: Array<EngineEvent> = [];

  const stop = engine.subscribe((event) => {
    events.push(event);
  });

  const playingElement = (): StandInAudio => {
    const element = elements.find((candidate) => !candidate.paused);

    if (element === undefined) throw new Error("No element is playing");

    return element;
  };

  return { engine, failing, elements, events, stop, playingElement };
};

describe("HtmlAudioEngine", () => {
  // Node has no media elements; the engine reads only these constants from their classes.
  beforeEach(() => {
    vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1, HAVE_FUTURE_DATA: 3 });
    vi.stubGlobal("MediaError", {
      MEDIA_ERR_ABORTED: 1,
      MEDIA_ERR_NETWORK: 2,
      MEDIA_ERR_DECODE: 3,
      MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the next song's failure when its preload had already failed", async () => {
    const { engine, failing, events, stop, playingElement } = setup();
    const a = source("a");
    const b = source("b");

    try {
      await engine.load(a, 0, true);
      failing.add(b.url);
      engine.preload(b);
      await settle();
      playingElement().finish();
      await settle();

      expect(events.filter((event) => event.type === "advanced")).toStrictEqual([
        { type: "advanced", key: "b" },
      ]);
      expect(events.at(-1)).toMatchObject({ type: "error", reason: "unsupported" });
    } finally {
      stop();
      engine.unload();
    }
  });

  it("plays the next song when only its preload failed", async () => {
    const { engine, failing, elements, events, stop, playingElement } = setup();
    const a = source("a");
    const b = source("b");

    try {
      await engine.load(a, 0, true);
      failing.add(b.url);
      engine.preload(b);
      await settle();
      failing.delete(b.url);
      playingElement().finish();
      await settle();

      expect(elements.find((element) => element.src === b.url)?.paused).toBe(false);
      expect(engine.samplePlayback().playing).toBe(true);
      expect(events.some((event) => event.type === "error")).toBe(false);
    } finally {
      stop();
      engine.unload();
    }
  });
});
