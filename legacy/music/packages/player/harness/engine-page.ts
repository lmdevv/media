/**
 * Engine harness page. Routes both audio elements through Web Audio into a worklet that measures
 * silence between sounds, so tests can read the real gap between songs.
 */
import { Schema } from "effect";

import type { EngineSource } from "../src/engine";
import { HtmlAudioEngine } from "../src/html-audio-engine";
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
    this.port.onmessage = (event) => {
      if (event.data === "reset") { this.heard = false; this.run = 0; this.longest = 0; this.sound = 0; }
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
    return true;
  }
}
registerProcessor("gap-meter", GapMeter);
`;

const context = new AudioContext();

const moduleUrl = URL.createObjectURL(new Blob([worklet], { type: "text/javascript" }));

await context.audioWorklet.addModule(moduleUrl);

const meter = new AudioWorkletNode(context, "gap-meter", { outputChannelCount: [2] });

meter.connect(context.destination);

const mediaBase = `http://127.0.0.1:${new URLSearchParams(location.search).get("media") ?? "4300"}`;

/** `?capture=0` leaves the elements on their default output, as in production. */
const capture = new URLSearchParams(location.search).get("capture") !== "0";

const engine = new HtmlAudioEngine(() => {
  const element = new Audio();

  if (capture) {
    element.crossOrigin = "anonymous";
    context.createMediaElementSource(element).connect(meter);
  }

  return element;
});

const events: Array<TimedEvent> = [];

engine.subscribe((event) => {
  events.push({ ...event, at: performance.now() });
});

const MeterReading = Schema.Struct({ longest: Schema.Finite, sound: Schema.Finite });

const decodeReading = Schema.decodeUnknownSync(MeterReading);

const fixture = (file: string): EngineSource => ({
  key: file,
  url: `${mediaBase}/fixtures/${file}`,
  durationMs: 3000,
});

const toMs = (frames: number): number => (frames / context.sampleRate) * 1000;

window.harness = {
  engine,
  events,
  load: (file, startMs, autoplay) => engine.load(fixture(file), startMs, autoplay),
  preload: (file) => {
    engine.preload(file === null ? null : fixture(file));
  },
  resetGap: () => {
    meter.port.postMessage("reset", []);
  },
  gap: () =>
    new Promise((resolve) => {
      meter.port.addEventListener(
        "message",
        (event) => {
          const reading = decodeReading(event.data);
          resolve({ longestGapMs: toMs(reading.longest), soundMs: toMs(reading.sound) });
        },
        { once: true },
      );

      meter.port.start();
      meter.port.postMessage("read", []);
    }),
};

await context.resume();

document.body.dataset["ready"] = "true";
