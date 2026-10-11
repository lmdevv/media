import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SegmentIndex } from "./fmp4";
import {
  durationMs,
  evictionEnd,
  fragmentAt,
  parseStreamTiming,
  placeTrack,
} from "./gapless-timeline";
import type { StreamTiming } from "./gapless-timeline";

const timingArbitrary: fc.Arbitrary<StreamTiming> = fc.record({
  primingSamples: fc.constantFrom(0, 1024, 2112),
  durationSamples: fc.integer({ min: 1, max: 48_000 * 900 }),
  sampleRate: fc.constantFrom(22_050, 44_100, 48_000, 88_200, 96_000, 192_000),
  estimated: fc.boolean(),
});

const headers =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | null =>
    values[name] ?? null;

describe("parseStreamTiming", () => {
  it("reads the three timing headers", () => {
    expect(
      parseStreamTiming(
        headers({
          "X-Music-Priming-Samples": "1024",
          "X-Music-Duration-Samples": "150001",
          "X-Music-Sample-Rate": "48000",
        }),
      ),
    ).toEqual({
      primingSamples: 1024,
      durationSamples: 150_001,
      sampleRate: 48_000,
      estimated: false,
    });
  });

  it("marks the length of a stream that is still being transcoded as estimated", () => {
    const live = {
      "X-Music-Priming-Samples": "1024",
      "X-Music-Duration-Samples": "150001",
      "X-Music-Sample-Rate": "48000",
    };

    expect(
      parseStreamTiming(headers({ ...live, "X-Music-Duration-Estimated": "1" }))?.estimated,
    ).toBe(true);
    expect(
      parseStreamTiming(headers({ ...live, "X-Music-Duration-Estimated": "0" }))?.estimated,
    ).toBe(false);
  });

  it("rejects missing, empty, fractional, negative, and zero values", () => {
    const valid = {
      "X-Music-Priming-Samples": "0",
      "X-Music-Duration-Samples": "10",
      "X-Music-Sample-Rate": "44100",
    };

    for (const [name, value] of [
      ["X-Music-Priming-Samples", ""],
      ["X-Music-Duration-Samples", "1.5"],
      ["X-Music-Sample-Rate", "-48000"],
      ["X-Music-Duration-Samples", "0"],
      ["X-Music-Sample-Rate", "0"],
      ["X-Music-Priming-Samples", "1e3"],
    ] as const) {
      expect(parseStreamTiming(headers({ ...valid, [name]: value }))).toBeNull();
    }

    expect(parseStreamTiming(headers({}))).toBeNull();
  });
});

describe("placeTrack", () => {
  it("maps the first real sample onto the start and spans exactly the real samples", () => {
    fc.assert(
      fc.property(timingArbitrary, fc.double({ min: 0, max: 36_000, noNaN: true }), (t, start) => {
        const placement = placeTrack(t, start);

        expect(placement.start).toBe(start);
        expect(placement.timestampOffset + t.primingSamples / t.sampleRate).toBeCloseTo(start, 9);
        expect(placement.end - placement.start).toBeCloseTo(t.durationSamples / t.sampleRate, 9);
        expect(durationMs(t)).toBeCloseTo((placement.end - placement.start) * 1000, 6);
      }),
    );
  });

  it("lays songs end to end without a gap or an overlap", () => {
    fc.assert(
      fc.property(fc.array(timingArbitrary, { minLength: 1, maxLength: 40 }), (timings) => {
        let start = 0;
        let samples = 0;

        for (const timing of timings) {
          const placement = placeTrack(timing, start);

          expect(placement.start).toBe(start);
          start = placement.end;
          samples += timing.durationSamples / timing.sampleRate;
        }

        // Accumulated float error stays far below one sample at 192 kHz (5.2 µs).
        expect(Math.abs(start - samples)).toBeLessThan(1e-7);
      }),
    );
  });
});

const indexArbitrary: fc.Arbitrary<SegmentIndex> = fc
  .array(
    fc.record({
      size: fc.integer({ min: 100, max: 500_000 }),
      duration: fc.integer({ min: 1, max: 96_000 }),
    }),
    {
      minLength: 1,
      maxLength: 60,
    },
  )
  .map((parts) => {
    let offset = 1000;
    let time = 0;

    return {
      timescale: 48_000,
      fragments: parts.map(({ size, duration }) => {
        const fragment = { offset, size, time, duration };
        offset += size;
        time += duration;

        return fragment;
      }),
    };
  });

describe("fragmentAt", () => {
  it("picks the fragment that holds the requested position", () => {
    fc.assert(
      fc.property(
        indexArbitrary,
        fc.constantFrom(0, 1024),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (index, primingSamples, fraction) => {
          const last = index.fragments.at(-1);
          const total = (last?.time ?? 0) + (last?.duration ?? 0);

          const timing = {
            primingSamples,
            durationSamples: total - primingSamples,
            sampleRate: 48_000,
            estimated: false,
          };

          if (timing.durationSamples <= 0) return;
          const position = (fraction * timing.durationSamples) / 48_000;
          const fragment = fragmentAt(index, timing, position);
          const mediaTime = position * 48_000 + primingSamples;

          expect(fragment).not.toBeNull();
          expect(fragment?.time ?? Number.NaN).toBeLessThanOrEqual(mediaTime + 1e-6);

          if (fragment !== null && fragment !== last) {
            expect(fragment.time + fragment.duration).toBeGreaterThan(mediaTime - 1e-6);
          }
        },
      ),
    );
  });

  it("clamps positions before the start to the first fragment", () => {
    fc.assert(
      fc.property(indexArbitrary, (index) => {
        const timing = {
          primingSamples: 0,
          durationSamples: 1,
          sampleRate: 48_000,
          estimated: false,
        };

        expect(fragmentAt(index, timing, -5)).toEqual(index.fragments[0]);
      }),
    );
  });
});

describe("evictionEnd", () => {
  it("evicts only what lies more than the kept span behind the playhead", () => {
    expect(evictionEnd(0, 10, 30)).toBeNull();
    expect(evictionEnd(0, 45, 30)).toBe(15);
    expect(evictionEnd(20, 45, 30)).toBeNull();
  });

  it("never evicts at or ahead of the kept span", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 60, noNaN: true }),
        (start, current, keep) => {
          const end = evictionEnd(start, current, keep);

          if (end !== null) {
            expect(end).toBeGreaterThan(start);
            expect(end).toBeLessThanOrEqual(current - keep + 1e-9);
          }
        },
      ),
    );
  });
});
