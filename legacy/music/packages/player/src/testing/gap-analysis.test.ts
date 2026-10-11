import { describe, expect, it } from "vitest";

import { analyzeTone } from "./gap-analysis";

const RATE = 48_000;

const FREQUENCY = 110;

/** 990 whole cycles of the tone, like the browser fixtures. */
const CUTS = [0, 150_001, 306_337, 432_000];

const PAD = 1000;

const tone = (from: number, to: number): Float32Array =>
  Float32Array.from({ length: to - from }, (_, index) =>
    Math.fround(0.5 * Math.sin((2 * Math.PI * FREQUENCY * (from + index)) / RATE)),
  );

/** Silence, the parts with `edits` applied at their starts, then silence. */
const played = (edits: ReadonlyArray<(part: Float32Array, index: number) => Float32Array>) => {
  const parts = CUTS.slice(1).map((cut, index) => {
    const part = tone(CUTS[index] ?? 0, cut);

    return edits.reduce((current, edit) => edit(current, index), part);
  });

  const total = parts.reduce((sum, part) => sum + part.length, 0) + 2 * PAD;
  const output = new Float32Array(total);
  let at = PAD;

  for (const part of parts) {
    output.set(part, at);
    at += part.length;
  }

  return output;
};

const insertSilence =
  (partIndex: number, samples: number) =>
  (part: Float32Array, index: number): Float32Array => {
    if (index !== partIndex) return part;
    const edited = new Float32Array(part.length + samples);
    edited.set(part, samples);

    return edited;
  };

const dropStart =
  (partIndex: number, samples: number) =>
  (part: Float32Array, index: number): Float32Array =>
    index === partIndex ? part.slice(samples) : part;

/** Plays the last 3 samples of part 1 again at the start of part 2. */
const repeatEnd = (part: Float32Array, index: number): Float32Array => {
  if (index !== 1) return part;
  const edited = new Float32Array(part.length + 3);
  edited.set(tone(150_001 - 3, 150_001));
  edited.set(part, 3);

  return edited;
};

describe("analyzeTone", () => {
  it("reads a perfect join as zero offset and the exact length", () => {
    const analysis = analyzeTone(played([]), RATE, FREQUENCY, CUTS, RATE);

    expect(analysis.boundaries.map((boundary) => boundary.at)).toEqual([150_001, 306_337]);

    for (const boundary of analysis.boundaries) {
      expect(Math.abs(boundary.offsetSamples)).toBeLessThan(0.01);
      expect(boundary.residual).toBeLessThan(1e-5);
    }

    expect(Math.abs(analysis.sampleError)).toBeLessThan(0.01);
    expect(analysis.longestSilence).toBeLessThanOrEqual(1);
  });

  it("measures inserted silence in samples", () => {
    const analysis = analyzeTone(played([insertSilence(1, 7)]), RATE, FREQUENCY, CUTS, RATE);

    expect(analysis.boundaries[0]?.offsetSamples).toBeCloseTo(7, 1);
    expect(Math.abs(analysis.boundaries[1]?.offsetSamples ?? 1)).toBeLessThan(0.01);
    expect(analysis.sampleError).toBeCloseTo(7, 1);
    expect(analysis.longestSilence).toBe(7);
    expect(analysis.boundaries[0]?.residual).toBeGreaterThan(0.001);
  });

  it("measures lost audio as a negative offset", () => {
    const analysis = analyzeTone(played([dropStart(2, 5)]), RATE, FREQUENCY, CUTS, RATE);

    expect(analysis.boundaries[1]?.offsetSamples).toBeCloseTo(-5, 1);
    expect(analysis.sampleError).toBeCloseTo(-5, 1);
  });

  it("measures repeated audio as a positive offset", () => {
    const analysis = analyzeTone(played([repeatEnd]), RATE, FREQUENCY, CUTS, RATE);

    expect(analysis.boundaries[0]?.offsetSamples).toBeCloseTo(3, 1);
    expect(analysis.longestSilence).toBeLessThanOrEqual(1);
  });

  it("finds a single-sample slip", () => {
    const analysis = analyzeTone(played([dropStart(1, 1)]), RATE, FREQUENCY, CUTS, RATE);

    expect(analysis.boundaries[0]?.offsetSamples).toBeCloseTo(-1, 1);
  });
});
