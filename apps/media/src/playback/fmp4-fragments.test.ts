import { describe, expect, it } from "@effect/vitest";

import {
  FRAGMENT_HEAD_BYTES,
  fragmentHeadLength,
  fragmentSpan,
  type VideoTiming,
  videoTiming,
} from "./fmp4-fragments.ts";

const uint32 = (value: number): Array<number> => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

const uint64 = (value: number): Array<number> => [
  ...uint32(Math.floor(value / 2 ** 32)),
  ...uint32(value % 2 ** 32),
];

const ascii = (text: string): Array<number> => [...new TextEncoder().encode(text)];

const box = (type: string, body: ReadonlyArray<number>): Array<number> => [
  ...uint32(8 + body.length),
  ...ascii(type),
  ...body,
];

const fullBox = (type: string, version: number, flags: number, body: ReadonlyArray<number>) =>
  box(type, [version, ...uint32(flags).slice(1), ...body]);

/** One edit: `mediaTime` -1 is an empty edit lasting `duration` movie units. */
interface Edit {
  readonly duration: number;
  readonly mediaTime: number;
}

const trak = (options: {
  readonly trackId: number;
  readonly handler: string;
  readonly timescale: number;
  readonly edits?: ReadonlyArray<Edit>;
}) =>
  box("trak", [
    ...fullBox("tkhd", 0, 3, [...uint32(0), ...uint32(0), ...uint32(options.trackId), 0, 0, 0, 0]),
    ...(options.edits === undefined
      ? []
      : box(
          "edts",
          fullBox("elst", 0, 0, [
            ...uint32(options.edits.length),
            ...options.edits.flatMap((edit) => [
              ...uint32(edit.duration),
              ...uint32(edit.mediaTime >>> 0),
              0,
              1,
              0,
              0,
            ]),
          ]),
        )),
    ...box("mdia", [
      ...fullBox("mdhd", 0, 0, [
        ...uint32(0),
        ...uint32(0),
        ...uint32(options.timescale),
        ...uint32(0),
      ]),
      ...fullBox("hdlr", 0, 0, [...uint32(0), ...ascii(options.handler), ...uint32(0)]),
    ]),
  ]);

const init = (
  traks: ReadonlyArray<ReadonlyArray<number>>,
  trex: ReadonlyArray<{ readonly trackId: number; readonly duration: number }> = [],
) =>
  new Uint8Array([
    ...box("ftyp", ascii("iso5")),
    ...box("moov", [
      ...fullBox("mvhd", 0, 0, [...uint32(0), ...uint32(0), ...uint32(1000), ...uint32(0)]),
      ...traks.flat(),
      ...box(
        "mvex",
        trex.flatMap((entry) =>
          fullBox("trex", 0, 0, [
            ...uint32(entry.trackId),
            ...uint32(1),
            ...uint32(entry.duration),
            ...uint32(0),
            ...uint32(0),
          ]),
        ),
      ),
    ]),
  ]);

interface Sample {
  readonly duration?: number;
  readonly composition?: number;
}

const traf = (options: {
  readonly trackId: number;
  readonly decodeTime: number;
  readonly samples: ReadonlyArray<Sample>;
  readonly defaultDuration?: number | undefined;
}) => {
  const durations = options.samples.some((sample) => sample.duration !== undefined);
  const compositions = options.samples.some((sample) => sample.composition !== undefined);

  return box("traf", [
    ...fullBox("tfhd", 0, options.defaultDuration === undefined ? 0 : 0x08, [
      ...uint32(options.trackId),
      ...(options.defaultDuration === undefined ? [] : uint32(options.defaultDuration)),
    ]),
    ...fullBox("tfdt", 1, 0, uint64(options.decodeTime)),
    ...fullBox("trun", 0, 0x01 | (durations ? 0x1_00 : 0) | 0x2_00 | (compositions ? 0x8_00 : 0), [
      ...uint32(options.samples.length),
      ...uint32(0),
      ...options.samples.flatMap((sample) => [
        ...(durations ? uint32(sample.duration ?? 0) : []),
        ...uint32(100),
        ...(compositions ? uint32((sample.composition ?? 0) >>> 0) : []),
      ]),
    ]),
  ]);
};

const sidx = (timescale: number, earliest: number, duration: number) =>
  fullBox("sidx", 1, 0, [
    ...uint32(1),
    ...uint32(timescale),
    ...uint64(earliest),
    ...uint64(0),
    0,
    0,
    0,
    1,
    ...uint32(1000),
    ...uint32(duration),
    ...uint32(0),
  ]);

const fragment = (head: ReadonlyArray<number>, trafs: ReadonlyArray<ReadonlyArray<number>>) =>
  new Uint8Array([
    ...box("styp", ascii("msdh")),
    ...head,
    ...box("moof", [...fullBox("mfhd", 0, 0, uint32(1)), ...trafs.flat()]),
    ...box("mdat", [0, 0, 0, 0]),
  ]);

/** 24 fps at a 16 kHz timescale, B-frames shifted by an edit, as ffmpeg muxes a Matroska copy. */
const VIDEO: VideoTiming = {
  trackId: 1,
  timescale: 16_000,
  presentationOffset: 1328,
  defaultSampleDuration: 0,
};

const gop = (count: number): ReadonlyArray<Sample> =>
  Array.from({ length: count }, (_, index) => ({
    duration: index % 3 === 0 ? 672 : 664,
    composition: index === 0 ? 1328 : ([2672, 672, 656][index % 3] ?? 0),
  }));

const total = (samples: ReadonlyArray<Sample>) =>
  samples.reduce((sum, sample) => sum + (sample.duration ?? 0), 0);

describe("videoTiming", () => {
  it("reads the video track's id, timescale, edit, and default duration", () => {
    expect(
      videoTiming(
        init(
          [
            trak({ trackId: 2, handler: "soun", timescale: 48_000, edits: [] }),
            trak({
              trackId: 1,
              handler: "vide",
              timescale: 16_000,
              edits: [{ duration: 0, mediaTime: 1328 }],
            }),
          ],
          [
            { trackId: 2, duration: 1024 },
            { trackId: 1, duration: 667 },
          ],
        ),
      ),
    ).toEqual({
      trackId: 1,
      timescale: 16_000,
      presentationOffset: 1328,
      defaultSampleDuration: 667,
    });
  });

  it("counts an empty edit before the media edit as presentation time", () => {
    expect(
      videoTiming(
        init([
          trak({
            trackId: 1,
            handler: "vide",
            timescale: 12_288,
            edits: [
              { duration: 500, mediaTime: -1 },
              { duration: 0, mediaTime: 1024 },
            ],
          }),
        ]),
      )?.presentationOffset,
    ).toBe(1024 - 6144);
  });

  it("presents media time 0 at 0 without an edit list", () => {
    expect(
      videoTiming(init([trak({ trackId: 1, handler: "vide", timescale: 90_000 })]))
        ?.presentationOffset,
    ).toBe(0);
  });

  it("finds no timing without a video track or a whole moov", () => {
    const audioOnly = init([trak({ trackId: 1, handler: "soun", timescale: 48_000 })]);
    const video = init([trak({ trackId: 1, handler: "vide", timescale: 16_000 })]);

    expect(videoTiming(audioOnly)).toBe(undefined);
    expect(videoTiming(video.subarray(0, video.byteLength - 4))).toBe(undefined);
  });
});

describe("fragmentSpan", () => {
  it("starts at the first sample's presentation time and ends where the last-presented one ends", () => {
    const samples = gop(48);
    const decodeTime = 31_984;
    const presentedLast = samples.length - 3;
    const last = samples[presentedLast] ?? { duration: 0, composition: 0 };

    const lastEnd =
      decodeTime +
      total(samples.slice(0, presentedLast)) +
      (last.composition ?? 0) -
      VIDEO.presentationOffset +
      (last.duration ?? 0);

    expect(fragmentSpan(VIDEO, fragment([], [traf({ trackId: 1, decodeTime, samples })]))).toEqual({
      start: decodeTime / 16_000,
      end: lastEnd / 16_000,
    });
  });

  it("starts an open-GOP fragment at its keyframe, presented after the leading pictures that follow it", () => {
    const frame = 1001;
    const shift = 2 * frame;
    const decoded = 235;

    const samples = [240, 238, 237, 239, 244, 242, 241, 243].map((presented, index) => ({
      duration: frame,
      composition: (presented - decoded - index) * frame + shift,
    }));

    expect(
      fragmentSpan(
        { trackId: 1, timescale: 24_000, presentationOffset: shift, defaultSampleDuration: 0 },
        fragment([], [traf({ trackId: 1, decodeTime: decoded * frame, samples })]),
      ),
    ).toEqual({ start: (240 * frame) / 24_000, end: (245 * frame) / 24_000 });
  });

  it("ignores a sidx that places the fragment a frame late, as ffmpeg 8.0 writes", () => {
    const samples = gop(48);
    const late = sidx(16_000, 31_984 + 656, total(samples));

    expect(
      fragmentSpan(
        VIDEO,
        fragment(
          [...late, ...sidx(48_000, 93_456, 96_000)],
          [
            traf({ trackId: 2, decodeTime: 93_456, samples: [{ duration: 1536 }] }),
            traf({ trackId: 1, decodeTime: 31_984, samples }),
          ],
        ),
      )?.start,
    ).toBe(31_984 / 16_000);
  });

  it("reads composition offsets as signed, as ffmpeg writes them", () => {
    expect(
      fragmentSpan(
        { ...VIDEO, presentationOffset: 0 },
        fragment(
          [],
          [
            traf({
              trackId: 1,
              decodeTime: 32_000,
              samples: [
                { duration: 1000, composition: -500 },
                { duration: 1000, composition: 500 },
              ],
            }),
          ],
        ),
      ),
    ).toEqual({ start: 31_500 / 16_000, end: 34_500 / 16_000 });
  });

  it("takes sample durations from tfhd, then trex, and leaves the end unknown without them", () => {
    const samples = [{ composition: 1328 }, { composition: 1328 }];

    const at = (defaultDuration: number | undefined, timing: VideoTiming) =>
      fragmentSpan(
        timing,
        fragment([], [traf({ trackId: 1, decodeTime: 16_000, samples, defaultDuration })]),
      );

    expect(at(500, VIDEO)).toEqual({ start: 1, end: 1 + 1000 / 16_000 });
    expect(at(undefined, { ...VIDEO, defaultSampleDuration: 250 })).toEqual({
      start: 1,
      end: 1 + 500 / 16_000,
    });
    expect(at(undefined, { ...VIDEO, defaultSampleDuration: undefined })).toEqual({
      start: 1,
      end: undefined,
    });
  });

  it("spans samples that share the defaults without stepping through each one", () => {
    const shared = fragment(
      [],
      [
        box("traf", [
          ...fullBox("tfhd", 0, 0x08, [...uint32(1), ...uint32(500)]),
          ...fullBox("tfdt", 1, 0, uint64(16_000)),
          ...fullBox("trun", 0, 0, uint32(0xff_ff_ff_ff)),
        ]),
      ],
    );

    expect(fragmentSpan({ ...VIDEO, presentationOffset: 0 }, shared)).toEqual({
      start: 1,
      end: 1 + (0xff_ff_ff_ff * 500) / 16_000,
    });
  });

  it("finds no span in boxes too short for their version and flags", () => {
    const short = fragment(
      [],
      [box("traf", [...fullBox("tfhd", 0, 0, uint32(1)), ...box("tfdt", [])])],
    );

    expect(fragmentSpan(VIDEO, short)).toBe(undefined);
  });

  it("finds no span without the video track's samples, or with the moof cut off", () => {
    const audio = fragment([], [traf({ trackId: 2, decodeTime: 0, samples: [{ duration: 1 }] })]);
    const video = fragment([], [traf({ trackId: 1, decodeTime: 0, samples: gop(4) })]);
    const moofEnd = fragmentHeadLength(video) ?? 0;

    expect(fragmentSpan(VIDEO, audio)).toBe(undefined);
    expect(fragmentSpan(VIDEO, video.subarray(0, moofEnd - 4))).toBe(undefined);
    expect(fragmentSpan(VIDEO, video.subarray(0, moofEnd))).toBeDefined();
  });
});

describe("fragmentHeadLength", () => {
  it("names the bytes through the moof, past the head when the moof is long", () => {
    const video = fragment(sidx(16_000, 0, 1), [
      traf({ trackId: 1, decodeTime: 0, samples: gop(2000) }),
    ]);

    const length = fragmentHeadLength(video.subarray(0, FRAGMENT_HEAD_BYTES));

    expect(length).toBeGreaterThan(FRAGMENT_HEAD_BYTES);
    expect(String.fromCodePoint(...video.subarray((length ?? 0) + 4, (length ?? 0) + 8))).toBe(
      "mdat",
    );
  });

  it("reads a 64-bit box size", () => {
    const styp = box("styp", ascii("msdh"));
    const mfhd = fullBox("mfhd", 0, 0, uint32(1));
    const moof = [...uint32(1), ...ascii("moof"), ...uint64(16 + mfhd.length), ...mfhd];

    expect(fragmentHeadLength(new Uint8Array([...styp, ...moof]))).toBe(styp.length + moof.length);
  });

  it("finds no moof after an mdat, or before the head reaches its header", () => {
    expect(fragmentHeadLength(new Uint8Array([...box("mdat", [0]), ...box("moof", [])]))).toBe(
      undefined,
    );
    expect(fragmentHeadLength(new Uint8Array(box("styp", ascii("msdh"))))).toBe(undefined);
  });
});
