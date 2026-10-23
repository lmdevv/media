/**
 * Engine harness page. Routes the engine's audio elements through Web Audio into a worklet that
 * measures silence between sounds and can record the output, so tests can read the real gap
 * between songs. `?engine=mse` drives `MseEngine` instead of `HtmlAudioEngine`.
 */
import { Schema } from "effect";

import type { EngineSource, PlayerEngine } from "../src/engine";
import { HtmlAudioEngine } from "../src/html-audio-engine";
import { MseEngine } from "../src/mse-engine";
import { analyzeTone } from "../src/testing/gap-analysis";
import type { TimedEvent } from "./globals";

/** Silence threshold. The fixture tones peak at 0.125; one sample near a zero crossing is ~0.007. */
const SILENCE = 0.001;

const worklet = `
class GapMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.heard = false;
    this.run = 0;
    this.longest = 0;
    this.sound = 0;
    this.recording = false;
    this.port.onmessage = (event) => {
      if (event.data === "reset") { this.heard = false; this.run = 0; this.longest = 0; this.sound = 0; }
      else if (event.data === "record") this.recording = true;
      else if (event.data === "stop") { this.recording = false; this.port.postMessage("stopped"); }
      else this.port.postMessage({ longest: this.longest, sound: this.sound });
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const length = input && input[0] ? input[0].length : 128;
    for (let i = 0; i < length; i++) {
      let peak = 0;
      if (input) for (const channel of input) peak = Math.max(peak, Math.abs(channel[i]));
      if (peak > ${SILENCE}) {
        if (this.heard && this.run > 0) this.longest = Math.max(this.longest, this.run);
        this.heard = true;
        this.run = 0;
        this.sound++;
      } else if (this.heard) {
        this.run++;
      }
    }
    if (input) input.forEach((channel, index) => output[index] && output[index].set(channel));
    if (this.recording && input && input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
}
registerProcessor("gap-meter", GapMeter);
`;

const params = new URLSearchParams(location.search);

const context = new AudioContext();

// WebKit keeps the context suspended until a user gesture; tests click the page first.
document.addEventListener("click", () => {
  void context.resume();
});

const moduleUrl = URL.createObjectURL(new Blob([worklet], { type: "text/javascript" }));

await context.audioWorklet.addModule(moduleUrl);

const meter = new AudioWorkletNode(context, "gap-meter", { outputChannelCount: [2] });

meter.connect(context.destination);

const mediaBase = `http://127.0.0.1:${params.get("media") ?? "4300"}`;

/** `?capture=0` leaves the elements on their default output, as in production. */
const capture = params.get("capture") !== "0";

/** Every audio element the engine was given, for reading what they buffered. */
const elements: Array<HTMLAudioElement> = [];

const audioElement = (): HTMLAudioElement => {
  const element = new Audio();

  elements.push(element);

  if (capture) {
    element.crossOrigin = "anonymous";
    context.createMediaElementSource(element).connect(meter);
  }

  return element;
};

const engine: PlayerEngine =
  params.get("engine") === "mse"
    ? new MseEngine(audioElement())
    : new HtmlAudioEngine(audioElement);

/** Chunks of the first output channel while recording. */
const recorded: Array<Float32Array> = [];

meter.port.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data;

  if (data instanceof Float32Array) recorded.push(data);
});

meter.port.start();

const events: Array<TimedEvent> = [];

engine.subscribe((event) => {
  events.push({ ...event, at: performance.now() });
});

const MeterReading = Schema.Struct({ longest: Schema.Finite, sound: Schema.Finite });

/**
 * A fixture source; `file` may carry a profile query (`gapless-flac-1.flac?p=fmp4-flac`). Most
 * fixtures are three-second tones; pass the length of a longer one.
 */
const fixture = (file: string, durationMs = 3000): EngineSource => ({
  key: file,
  url: `${mediaBase}/fixtures/${file}`,
  durationMs,
  finished: false,
});

const toMs = (frames: number): number => (frames / context.sampleRate) * 1000;

const isReading = Schema.is(MeterReading);

/** Resolves with the next worklet message that passes `accept`. */
const nextMessage = <A>(accept: (data: unknown) => data is A): Promise<A> =>
  new Promise((resolve) => {
    const listener = (event: MessageEvent): void => {
      const data: unknown = event.data;

      if (!accept(data)) return;
      meter.port.removeEventListener("message", listener);
      resolve(data);
    };

    meter.port.addEventListener("message", listener);
  });

const isStopped = (data: unknown): data is "stopped" => data === "stopped";

window.harness = {
  engine,
  events,
  load: async (file, startMs, autoplay, durationMs) => {
    await context.resume();
    await engine.load(fixture(file, durationMs), startMs, autoplay);
  },
  preload: (file) => {
    engine.preload(file === null ? null : fixture(file));
  },
  buffered: () =>
    elements.flatMap((element) =>
      Array.from(
        { length: element.buffered.length },
        (_, index) => [element.buffered.start(index), element.buffered.end(index)] as const,
      ),
    ),
  resetGap: () => {
    meter.port.postMessage("reset", []);
  },
  gap: async () => {
    const reading = nextMessage(isReading);
    meter.port.postMessage("read", []);
    const { longest, sound } = await reading;

    return { longestGapMs: toMs(longest), soundMs: toMs(sound) };
  },
  record: () => {
    recorded.length = 0;
    meter.port.postMessage("record", []);
  },
  analyze: async (cuts, frequency, sourceRate) => {
    const stopped = nextMessage(isStopped);
    meter.port.postMessage("stop", []);
    await stopped;
    const length = recorded.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let at = 0;

    for (const chunk of recorded) {
      samples.set(chunk, at);
      at += chunk.length;
    }

    return analyzeTone(samples, context.sampleRate, frequency, cuts, sourceRate);
  },
};

document.body.dataset["ready"] = "true";
