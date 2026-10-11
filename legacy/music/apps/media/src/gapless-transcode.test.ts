import { join } from "node:path";

import { TrackId } from "@music/commands/ids";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";

import { AAC_TAIL_PADDING, aacSampleRate, countFrameSamples, runTool } from "./ffmpeg.ts";
import * as Files from "./files.ts";
import { declaredLength, measureTiming } from "./sample-timing.ts";
import { MEDIA_TEST_TIMEOUT, temporaryDirectory, testConfig } from "./testing/fixtures.ts";
import { runScoped } from "./testing/run.ts";
import { topLevelBoxes } from "./testing/mp4-boxes.ts";
import { decodeMono, sineSegment } from "./testing/sine.ts";
import * as Transcoder from "./transcoder.ts";

/** A piece of the tone that starts and ends off every codec's frame grid (1024, 1152, 4096). */
const START = 150_001;

const END = 306_337;

const LENGTH = END - START;

const transcoderAt = (dataDir: string) =>
  Layer.build(Transcoder.layer.pipe(Layer.provide(testConfig(dataDir)))).pipe(
    Effect.flatMap((context) => Transcoder.Transcoder.pipe(Effect.provideContext(context))),
  );

/** RMS difference between `actual[offset + i]` and `expected[i]` over all of `expected`. */
const rmsAt = (actual: Float32Array, expected: Float32Array, offset: number): number => {
  let sum = 0;

  for (let index = 0; index < expected.length; index += 1) {
    const difference = (actual[offset + index] ?? 0) - (expected[index] ?? 0);
    sum += difference * difference;
  }

  return Math.sqrt(sum / expected.length);
};

/** The offset within ±`range` of `around` where `actual` best matches `expected`. */
const bestOffset = (
  actual: Float32Array,
  expected: Float32Array,
  around: number,
  range: number,
): number => {
  let best = around;

  for (let offset = around - range; offset <= around + range; offset += 1) {
    if (rmsAt(actual, expected, offset) < rmsAt(actual, expected, best)) best = offset;
  }

  return best;
};

describe("gapless transcodes", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  for (const [extension, profile, priming] of [
    ["flac", "fmp4-flac", 0],
    ["mp3", "fmp4-flac", 0],
    ["m4a", "fmp4-flac", 0],
    ["flac", "fmp4-aac", 1024],
    ["mp3", "fmp4-aac", 1024],
    ["m4a", "fmp4-aac", 1024],
  ] as const) {
    it(`${extension} to ${profile}: measured timing trims to the exact source samples`, () =>
      runScoped(
        Effect.gen(function* () {
          const scratch = yield* temporaryDirectory("sine");
          const source = yield* sineSegment(scratch, "piece", extension, START, END);
          const transcoder = yield* transcoderAt(yield* temporaryDirectory("data"));

          const input = {
            trackId: TrackId.make("sine"),
            profile,
            source,
            mtimeMs: 1,
            codec: extension === "m4a" ? "aac" : extension,
          };

          const output = yield* transcoder.transcode(input);

          // Encoder delay is measured, not assumed: ffmpeg's AAC encoder primes with 1024
          // samples, FLAC with none, and the length is the source's decoded length.
          expect(Option.getOrUndefined(output.timing)).toEqual({
            primingSamples: priming,
            durationSamples: LENGTH,
            sampleRate: 48_000,
          });

          // Fragmented, with an empty moov, a fragment index for seeking, and no edit list for
          // browsers to apply on their own.
          const bytes = yield* Files.readWholeFile(output.path);
          const boxes = topLevelBoxes(bytes).map((box) => box.type);

          expect(boxes.slice(0, 4)).toEqual(["ftyp", "moov", "sidx", "moof"]);
          expect(Buffer.from(bytes).includes("elst")).toBe(false);

          // After skipping the priming, the decoded output lines up with the decoded source
          // sample for sample.
          // ffmpeg 6 decodes an AAC .m4a with its end padding; only the real samples count.
          const expected = (yield* decodeMono(source, scratch)).subarray(0, LENGTH);
          const decoded = yield* decodeMono(output.path, scratch);

          expect(expected.length).toBe(LENGTH);

          if (profile === "fmp4-flac") {
            expect(rmsAt(decoded, expected, priming)).toBeLessThan(1e-6);
            expect(decoded.length).toBeGreaterThanOrEqual(LENGTH);
          } else {
            expect(bestOffset(decoded, expected, priming, 48)).toBe(priming);
            expect(rmsAt(decoded, expected, priming)).toBeLessThan(0.01);
            expect(decoded.length).toBeGreaterThanOrEqual(priming + LENGTH + AAC_TAIL_PADDING);
          }

          // The second request reuses the file and its sidecar.
          const again = yield* transcoder.transcode(input);

          expect(again).toEqual(output);
          expect(yield* Files.statPath(`${output.path}.json`)).toMatchObject({ kind: "file" });
        }),
      ));
  }

  for (const [rate, profile, expected] of [
    [96_000, "fmp4-aac", { primingSamples: 1024, durationSamples: 120_000, sampleRate: 48_000 }],
    [88_200, "fmp4-aac", { primingSamples: 1024, durationSamples: 110_250, sampleRate: 44_100 }],
    [44_100, "fmp4-aac", { primingSamples: 1024, durationSamples: 110_250, sampleRate: 44_100 }],
    [96_000, "fmp4-flac", { primingSamples: 0, durationSamples: 240_000, sampleRate: 96_000 }],
  ] as const) {
    it(`measures ${profile} timing for a ${rate} Hz source`, () =>
      runScoped(
        Effect.gen(function* () {
          const scratch = yield* temporaryDirectory("rate");
          const source = join(scratch, "tone.flac");

          yield* runTool("ffmpeg", [
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=440:sample_rate=${rate}:duration=2.5`,
            "-ac",
            "2",
            "-c:a",
            "flac",
            source,
          ]);

          const transcoder = yield* transcoderAt(yield* temporaryDirectory("data"));

          const output = yield* transcoder.transcode({
            trackId: TrackId.make(`rate-${rate}`),
            profile,
            source,
            mtimeMs: 1,
            codec: "flac",
          });

          expect(Option.getOrUndefined(output.timing)).toEqual(expected);
        }),
      ));
  }

  it("re-encodes when the timing sidecar is missing", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("sine");
        const source = yield* sineSegment(scratch, "piece", "flac", 0, 4800);
        const transcoder = yield* transcoderAt(yield* temporaryDirectory("data"));

        const input = {
          trackId: TrackId.make("sine"),
          profile: "fmp4-aac" as const,
          source,
          mtimeMs: 1,
          codec: "flac",
        };

        const first = yield* transcoder.transcode(input);
        yield* Files.removePath(`${first.path}.json`);
        const second = yield* transcoder.transcode(input);

        expect(second.timing).toEqual(first.timing);
        expect(yield* Files.statPath(`${first.path}.json`)).toMatchObject({ kind: "file" });
      }),
    ));
});

describe("aacSampleRate", () => {
  it("keeps AAC rates and maps the rest into AAC's range", () => {
    expect(aacSampleRate(44_100)).toBe(44_100);
    expect(aacSampleRate(48_000)).toBe(48_000);
    expect(aacSampleRate(22_050)).toBe(22_050);
    expect(aacSampleRate(88_200)).toBe(44_100);
    expect(aacSampleRate(176_400)).toBe(44_100);
    expect(aacSampleRate(96_000)).toBe(48_000);
    expect(aacSampleRate(192_000)).toBe(48_000);
    expect(aacSampleRate(37_800)).toBe(48_000);
  });

  it("always lands on a rate AAC LC supports", () => {
    const supported = [48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8000];

    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 768_000 }), (rate) => {
        expect(supported).toContain(aacSampleRate(rate));
      }),
    );
  });
});

describe("countFrameSamples", () => {
  it("sums the duration column and skips headers", () => {
    const listing = [
      "#tb 0: 1/48000",
      "#media_type 0: audio",
      "0,          0,          0,     4096,    32768, 0x1a2b3c4d",
      "0,       4096,       4096,     1905,    15240, 0x0badf00d",
      "",
    ].join("\n");

    expect(countFrameSamples(listing)).toBe(6001);
  });
});

describe("measureTiming", () => {
  it("recovers the priming from the timeline, the real length, and the appended tail", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 16_384 }),
        fc.integer({ min: 1, max: 500_000_000 }),
        fc.constantFrom(0, AAC_TAIL_PADDING),
        fc.constantFrom(44_100, 48_000, 96_000),
        (priming, real, tail, rate) => {
          expect(measureTiming(priming + real + tail, real, tail, rate, null)).toEqual(
            Option.some({ primingSamples: priming, durationSamples: real, sampleRate: rate }),
          );
        },
      ),
    );
  });

  it("cuts decoded end padding at a shorter declared length, keeping the priming", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 1, max: 1023 }),
        (real, padding) => {
          expect(
            measureTiming(1024 + real + padding + 2048, real + padding, 2048, 48_000, real),
          ).toEqual(
            Option.some({ primingSamples: 1024, durationSamples: real, sampleRate: 48_000 }),
          );
          // A longer declared length (an estimate) never extends the decoded audio.
          expect(measureTiming(real, real, 0, 48_000, real + padding)).toEqual(
            Option.some({ primingSamples: 0, durationSamples: real, sampleRate: 48_000 }),
          );
        },
      ),
    );
  });

  it("rejects numbers that do not add up", () => {
    expect(measureTiming(1000, 2000, 0, 48_000, null)).toEqual(Option.none());
    expect(measureTiming(100_000, 0, 0, 48_000, null)).toEqual(Option.none());
    expect(measureTiming(100_000, 1000, 0, 48_000, null)).toEqual(Option.none());
    expect(measureTiming(5000, 1000, 0, 0, null)).toEqual(Option.none());
    expect(measureTiming(5000, Number.NaN, 0, 48_000, null)).toEqual(Option.none());
  });
});

describe("declaredLength", () => {
  it("trusts MP4 and MOV lengths only, converted to output samples", () => {
    expect(declaredLength("mov,mp4,m4a,3gp,3g2,mj2", 156_336, "1/48000", 48_000)).toBe(156_336);
    expect(declaredLength("mov,mp4,m4a,3gp,3g2,mj2", 88_200, "1/44100", 48_000)).toBe(96_000);
    expect(declaredLength("mp3", 46_400_256, "1/14112000", 48_000)).toBeNull();
    expect(declaredLength("flac", 156_336, "1/48000", 48_000)).toBeNull();
    expect(declaredLength("mov,mp4,m4a,3gp,3g2,mj2", undefined, "1/48000", 48_000)).toBeNull();
    expect(declaredLength("mov,mp4,m4a,3gp,3g2,mj2", 10, "1/0", 48_000)).toBeNull();
  });
});
