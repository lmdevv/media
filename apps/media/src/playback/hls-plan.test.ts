import { describe, expect, it } from "@effect/vitest";
import * as fc from "fast-check";

import {
  groupFragments,
  planGridSegments,
  planKeyframeSegments,
  reachOf,
  renderPlaylist,
  type SegmentPlan,
  segmentAt,
} from "./hls-plan.ts";

describe("HLS segment plans", () => {
  it("cuts transcodes on a fixed grid and merges a tiny tail", () => {
    expect(planGridSegments(0, 12)).toStrictEqual({ starts: [0, 4, 8], end: 12 });
    expect(planGridSegments(1.5, 10.2)).toStrictEqual({ starts: [1.5, 5.5, 9.5], end: 11.7 });
    expect(planGridSegments(0, 8.3)).toStrictEqual({ starts: [0, 4], end: 8.3 });
  });

  it("groups keyframes into segments of at least the target length", () => {
    const keyframes = [0, 1, 2.5, 4.2, 5, 9, 10, 15.9];

    expect(planKeyframeSegments(keyframes, 0, 16)).toStrictEqual({ starts: [0, 4.2, 9], end: 16 });
    expect(planKeyframeSegments([0, 10, 20], 0, 25)).toStrictEqual({
      starts: [0, 10, 20],
      end: 25,
    });
    expect(planKeyframeSegments([], 0, 25)).toStrictEqual({ starts: [0], end: 25 });
  });

  it("cuts the first transcode segments short from where playback starts", () => {
    expect(planGridSegments(0, 30, { quickStart: 0 }).starts).toStrictEqual([
      0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 28,
    ]);

    const resumed = planGridSegments(0, 30, { quickStart: 13.5 });

    expect(resumed.starts).toStrictEqual([0, 4, 8, 12, 13, 14, 16, 18, 20, 24, 28]);
    expect(resumed.starts.filter((time) => time % 4 === 0)).toStrictEqual(
      planGridSegments(0, 30).starts,
    );
    expect(planGridSegments(0, 30, { quickStart: 29 }).starts.at(-1)).toBe(29);
    expect(planGridSegments(0, 1.2, { quickStart: 0 })).toStrictEqual({ starts: [0], end: 1.2 });

    const start = 1.2377141149712325;
    const late = planGridSegments(start, 2000, { quickStart: start + 255 * 4 + 1 }).starts;

    expect(late.filter((time) => Math.abs(time - (start + 256 * 4)) < 1e-9)).toHaveLength(1);
    expect(new Set(late).size).toBe(late.length);
  });

  it("gives copies one keyframe per segment for eight seconds from the start keyframe", () => {
    const keyframes = Array.from({ length: 20 }, (_, index) => index * 2);

    expect(planKeyframeSegments(keyframes, 0, 40, { quickStart: 0 }).starts).toStrictEqual([
      0, 2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 36,
    ]);

    const resumed = planKeyframeSegments(keyframes, 0, 40, { quickStart: 21 }).starts;

    expect(resumed).toStrictEqual([0, 4, 8, 12, 16, 20, 22, 24, 26, 28, 32, 36]);
    expect(resumed.every((time) => keyframes.includes(time))).toBe(true);

    const everyFrame = Array.from({ length: 24 * 20 }, (_, index) => index / 24);

    expect(planKeyframeSegments(everyFrame, 0, 20, { quickStart: 0 }).starts).toStrictEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16,
    ]);

    expect(
      planKeyframeSegments(keyframes, -0.005, 40, { quickStart: -0.005 }).starts,
    ).toStrictEqual([0, 2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 36]);
  });

  it("keeps every plan continuous and ascending around the switch to normal length", () => {
    for (const quickStart of [0, 3.9, 4, 17.25, 59.9]) {
      const grid = planGridSegments(0.04, 60, { quickStart });

      const copy = planKeyframeSegments(
        Array.from({ length: 50 }, (_, index) => 0.04 + index * 1.2),
        0.04,
        60,
        { quickStart },
      );

      for (const plan of [grid, copy]) {
        const durations = plan.starts.map(
          (time, index) => (plan.starts[index + 1] ?? plan.end) - time,
        );

        expect(durations.every((duration) => duration > 0)).toBe(true);
        expect(durations.reduce((total, duration) => total + duration, 0)).toBeCloseTo(60, 6);
        expect(plan.starts[segmentAt(plan, quickStart)]).toBeLessThanOrEqual(quickStart + 0.04);
        expect(Math.max(...durations.slice(segmentAt(plan, quickStart), -1))).toBeLessThan(6);
      }
    }
  });

  it("finds the segment containing a time", () => {
    const plan = { starts: [0, 4.2, 9], end: 16 };

    expect([0, 4.1, 4.2, 8.99, 9, 15, 100, -1].map((time) => segmentAt(plan, time))).toStrictEqual([
      0, 0, 1, 1, 2, 2, 2, 0,
    ]);
  });

  it("renders a VOD playlist", () => {
    const playlist = renderPlaylist(
      { starts: [0, 4.2, 9], end: 16 },
      { init: "init.mp4?t=1", segment: (index) => `${index}.m4s?t=1` },
    );

    expect(playlist).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:7",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-MAP:URI="init.mp4?t=1"',
        "#EXTINF:4.200000,",
        "0.m4s?t=1",
        "#EXTINF:4.800000,",
        "1.m4s?t=1",
        "#EXTINF:7.000000,",
        "2.m4s?t=1",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"),
    );
  });

  it("trusts a written fragment's end only when it lands on the next start", () => {
    const first = { start: 12, end: 15.958 };

    expect(reachOf([first], 16)).toEqual({ followed: false, written: false });
    expect(reachOf([{ start: 12, end: 16.003 }], 16)).toEqual({ followed: false, written: true });
    expect(reachOf([{ start: 12, end: 15.997 }], 16)).toEqual({ followed: false, written: true });
    expect(reachOf([{ start: 12, end: 16.04 }], 16)).toEqual({ followed: false, written: false });
    expect(reachOf([{ start: 12, end: undefined }], 16)).toEqual({
      followed: false,
      written: false,
    });
    expect(reachOf([first, { start: 15.958, end: 16.04 }], 16)).toEqual({
      followed: false,
      written: false,
    });
    expect(reachOf([first, { start: 16.002, end: 20 }], 16)).toEqual({
      followed: true,
      written: true,
    });
    expect(reachOf([first], undefined)).toEqual({ followed: false, written: false });
  });
});

interface WrittenFragment {
  readonly keyframe: number;
  readonly start: number;
  readonly end: number;
}

interface CopyRun {
  readonly plan: SegmentPlan;
  readonly startSegment: number;
  readonly fragments: ReadonlyArray<WrittenFragment>;
}

const FRAME_RATES = [24_000 / 1001, 25, 30_000 / 1001, 50, 60_000 / 1001] as const;

const copyRuns: fc.Arbitrary<CopyRun> = fc
  .record({
    rate: fc.constantFrom(...FRAME_RATES),
    sourceStart: fc.constantFrom(0, 0.042, 1.4),
    gops: fc.array(
      fc.record({
        frames: fc.oneof(fc.integer({ min: 1, max: 24 }), fc.integer({ min: 25, max: 360 })),
        leading: fc.integer({ min: 0, max: 30 }),
        rounding: fc.double({ min: -0.004, max: 0.004, noNaN: true }),
      }),
      { minLength: 1, maxLength: 40 },
    ),
    tailFrames: fc.integer({ min: 1, max: 240 }),
    quickStart: fc.option(fc.double({ min: 0, max: 0.999, noNaN: true }), { nil: undefined }),
    startPick: fc.nat(),
    seekEarlier: fc.nat({ max: 3 }),
  })
  .map(({ rate, sourceStart, gops, tailFrames, quickStart, startPick, seekEarlier }) => {
    const frame = 1 / rate;

    const firstFrames = gops.map((_, index) =>
      gops.slice(0, index).reduce((total, gop) => total + gop.frames, 0),
    );

    const keyframes = firstFrames.map((frames) => sourceStart + frames * frame);
    const totalFrames = (firstFrames.at(-1) ?? 0) + (gops.at(-1)?.frames ?? 0) + tailFrames;
    const duration = totalFrames * frame;

    const plan = planKeyframeSegments(
      keyframes,
      sourceStart,
      duration,
      quickStart === undefined ? {} : { quickStart: sourceStart + quickStart * duration },
    );

    const leadingSpan = (index: number): number => {
      const before = gops[index - 1];
      const leading = gops[index]?.leading ?? 0;

      return before === undefined
        ? 0
        : Math.min(leading, before.frames - 1, Math.floor(0.5 * rate)) * frame;
    };

    const endBeforeNextLeadingPictures = (index: number): number => {
      const next = keyframes[index + 1];

      return next === undefined ? plan.end : next - leadingSpan(index + 1);
    };

    const fragments = keyframes.map((keyframe, index) => ({
      keyframe,
      start: keyframe + (gops[index]?.rounding ?? 0),
      end: endBeforeNextLeadingPictures(index),
    }));

    const startSegment = startPick % plan.starts.length;
    const previous = plan.starts[startSegment - 1];

    const seekedTo =
      previous === undefined ? 0 : Math.max(0, keyframes.indexOf(previous) - seekEarlier);

    return { plan, startSegment, fragments: fragments.slice(seekedTo) };
  });

describe("grouping a copy's fragments into planned segments", () => {
  const plan: SegmentPlan = { starts: [0, 10.01, 18.268, 21.396, 22.606, 24.274], end: 30 };

  const firstLeadingPicture = 9.884;
  const first = { start: 0, end: firstLeadingPicture };
  const second = { start: 10.01, end: 18.268 };

  const fragments = [
    first,
    second,
    { start: 18.267, end: 21.396 },
    { start: 21.395, end: 22.605 },
    { start: 22.605, end: 24.274 },
    { start: 24.273, end: 30 },
  ];

  it("files each fragment of an open-GOP copy in exactly one segment, its keyframe's", () => {
    expect([...groupFragments(plan, 0, 0, fragments)]).toStrictEqual(
      fragments.map((fragment, index) => [index, [fragment]]),
    );
  });

  it("waits for the next keyframe's fragment when leading pictures end a segment early", () => {
    expect(reachOf([first], plan.starts[1])).toEqual({ followed: false, written: false });
    expect(reachOf([first, second], plan.starts[1])).toEqual({ followed: true, written: true });
    expect(reachOf([first, second], plan.starts[2])).toEqual({ followed: false, written: true });
  });

  it("partitions every run's fragments into its planned segments and never calls one ready early", () => {
    fc.assert(
      fc.property(copyRuns, ({ plan: planned, startSegment, fragments: written }) => {
        const from = planned.starts[startSegment] ?? planned.end;
        const lead = written.findIndex((fragment) => fragment.keyframe === from);
        const groups = groupFragments(planned, startSegment, from, written);
        const indexes = [...groups.keys()].toSorted((left, right) => left - right);

        expect(lead).toBeGreaterThanOrEqual(0);
        expect(indexes.flatMap((index) => groups.get(index) ?? [])).toStrictEqual(
          written.slice(lead),
        );

        for (const [index, members] of groups) {
          for (const fragment of members) {
            expect(planned.starts.findLastIndex((start) => start <= fragment.keyframe)).toBe(index);
          }
        }

        const last = indexes.at(-1) ?? startSegment;

        for (let index = startSegment; index <= last; index += 1) {
          expect(groups.get(index)?.length ?? 0, `segment ${String(index)}`).toBeGreaterThan(0);
        }

        for (let arrived = 1; arrived <= written.length; arrived += 1) {
          const prefix = written.slice(0, arrived);

          for (const [index, members] of groups) {
            const { followed, written: whole } = reachOf(prefix, planned.starts[index + 1]);
            const lastMember = members.at(-1);

            if ((followed || whole) && lastMember !== undefined) {
              expect(
                prefix.includes(lastMember),
                `segment ${String(index)} ready after ${String(arrived)} fragments`,
              ).toBe(true);
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
