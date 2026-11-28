import { describe, expect, it } from "@effect/vitest";
import { castCapabilities } from "@media/contracts/cast";
import type { ClientCapabilities } from "@media/contracts/media-playback";

import type { VideoColour } from "@media/contracts/models/catalog";

import type { MediaProbe, VideoStream } from "../media/media-probe.ts";
import { verifiedFor } from "../testing/capability-snapshots.ts";
import {
  AudioPlan,
  decidePlayback,
  type DolbyVisionCopy,
  ENCODE_REFUSALS,
  PlaybackPlan,
  VideoPlan,
} from "./playback-decision.ts";
import { hlsCommand } from "./transcode-command.ts";
import { type CapabilityKey, type GpuDomain, Op } from "./video-ops.ts";

/** The colour of each kind's stream, as the probe reads it. */
const COLOURS = {
  hdr10: {
    transfer: "smpte2084",
    primaries: "bt2020",
    matrix: "bt2020nc",
    range: "limited",
    mastering: { minLuminance: 0.005, maxLuminance: 1000 },
  },
  hlg: { transfer: "arib-std-b67", primaries: "bt2020", matrix: "bt2020nc", range: "limited" },
  ipt: { range: "limited" },
  sdr: { transfer: "bt709", primaries: "bt709", matrix: "bt709", range: "limited" },
} as const satisfies Record<string, VideoColour>;

/** The colour of a Dolby Vision base layer, by its compatibility id. */
const BASE_COLOURS: ReadonlyMap<number, VideoColour> = new Map([
  [0, COLOURS.ipt],
  [1, COLOURS.hdr10],
  [2, COLOURS.sdr],
  [4, COLOURS.hlg],
  [6, COLOURS.hdr10],
]);

/**
 * A 1080p HEVC Main 10 film at 24 frames a second, of `dynamicRange` in `colour`, with what `extra`
 * adds: a size and rate at which libplacebo keeps up on both GPU paths.
 */
const hevc10 = (
  dynamicRange: VideoStream["dynamicRange"],
  colour: VideoColour,
  extra: Pick<VideoStream, "hdr10Plus" | "dolbyVision" | "dolbyVisionRpu"> = {},
): VideoStream => ({
  index: 0,
  codec: "hevc",
  profile: "Main 10",
  level: 153,
  bitDepth: 10,
  pixelFormat: "yuv420p10le",
  width: 1920,
  height: 1080,
  frameRate: 24,
  dynamicRange,
  colour,
  hdr10Plus: extra.hdr10Plus,
  dolbyVision: extra.dolbyVision,
  dolbyVisionRpu: extra.dolbyVisionRpu,
});

/**
 * Dolby Vision of `profile` and `compatibility`, in the colour its base layer has, its first
 * picture carrying an RPU unless `rpu` is false.
 */
const dolbyVisionOf = (profile: number, compatibility: number, rpu = true): VideoStream =>
  hevc10("dolby-vision", BASE_COLOURS.get(compatibility) ?? COLOURS.ipt, {
    dolbyVision: { profile, level: 6, compatibility },
    dolbyVisionRpu: rpu ? true : undefined,
  });

const file = (container: MediaProbe["container"], video: VideoStream): MediaProbe => ({
  container,
  formatName: container,
  durationSeconds: 600,
  startSeconds: 0,
  bitRate: undefined,
  video,
  audio: [{ index: 1, codec: "aac", channels: 2, default: true }],
  subtitles: [],
  chapters: [],
});

/** An iPhone, as its app declares it: HEVC with HDR10, HLG, and Dolby Vision, in MP4 or HLS. */
const iphone: ClientCapabilities = {
  containers: ["mp4", "mov"],
  videoCodecs: [
    { codec: "h264", maxLevel: 52, maxBitDepth: 8 },
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg", "dolby-vision"],
    },
  ],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

/** A browser on an HDR display, as the web app declares it: HDR10 and HLG, no Dolby Vision. */
const hdrBrowser: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [
    { codec: "h264", maxBitDepth: 8 },
    { codec: "hevc", maxBitDepth: 10, dynamicRanges: ["hdr10", "hlg"] },
  ],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

/** A browser on an SDR display: H.264 alone. */
const sdrBrowser: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

const deciding =
  (domains: ReadonlyArray<GpuDomain>, refused: (key: CapabilityKey) => boolean = () => false) =>
  (media: MediaProbe, client: ClientCapabilities) =>
    decidePlayback(media, client, {
      audioIndex: undefined,
      capabilities: verifiedFor(media, domains, refused),
    });

const cpu = deciding([]);

const qsv = deciding(["qsv"]);

/** Quick Sync on a host whose Vulkan is not proven: no libplacebo. */
const qsvWithoutVulkan = deciding(["qsv"], (key) => key.includes(".placebo:"));

/** How a plan delivers the video, in a word, with what a copy keeps or the tone map that ran. */
const delivery = (plan: PlaybackPlan): string =>
  PlaybackPlan.$match(plan, {
    Direct: () => "direct",
    Unsupported: ({ reason }) => `refused ${reason}`,
    Hls: ({ video }) =>
      VideoPlan.$match(video, {
        Copy: (copied) => `copy ${copied.dolbyVision}`,
        Encode: ({ pipeline }) =>
          `encode ${pipeline.steps
            .filter((step) => Op.$is("ToneMap")(step.op))
            .map((step) => step.capability)
            .join(" ")}`.trim(),
      }),
  });

/** How `decide` delivers `video` in Matroska to an SDR browser. */
const sdrDelivery = (decide: typeof qsv, video: VideoStream): string =>
  delivery(decide(file("mkv", video), sdrBrowser));

/**
 * How `decide` delivers `video` to each client, as an MP4 an iPhone and a browser could play as
 * stored and as Matroska, which only a copy or an encode reaches: the original-file ladder.
 */
const ladder = (decide: typeof qsv, video: VideoStream) => ({
  "iphone mp4": delivery(decide(file("mp4", video), iphone)),
  "iphone mkv": delivery(decide(file("mkv", video), iphone)),
  "hdr browser mp4": delivery(decide(file("mp4", video), hdrBrowser)),
  "hdr browser mkv": delivery(decide(file("mkv", video), hdrBrowser)),
  "sdr browser mp4": delivery(decide(file("mp4", video), sdrBrowser)),
});

describe("what each kind of source gets", () => {
  it("plays HDR10 and HLG as stored where declared, and maps them for SDR", () => {
    for (const [range, colour] of [
      ["hdr10", COLOURS.hdr10],
      ["hlg", COLOURS.hlg],
    ] as const) {
      expect(ladder(qsv, hevc10(range, colour))).toStrictEqual({
        "iphone mp4": "direct",
        "iphone mkv": "copy none",
        "hdr browser mp4": "direct",
        "hdr browser mkv": "copy none",
        "sdr browser mp4": `encode tonemap.qsv.placebo:${range === "hdr10" ? "pq" : "hlg"}`,
      });
    }
  });

  it("plays Dolby Vision 8 as stored only for Dolby Vision, and copies its base layer elsewhere", () => {
    for (const [compatibility, toneMap] of [
      [1, " tonemap.qsv.placebo:pq"],
      [2, ""],
      [4, " tonemap.qsv.placebo:hlg"],
    ] as const) {
      expect(ladder(qsv, dolbyVisionOf(8, compatibility))).toStrictEqual({
        "iphone mp4": "direct",
        "iphone mkv": "copy compatible",
        "hdr browser mp4": "copy base",
        "hdr browser mkv": "copy base",
        "sdr browser mp4": `encode${toneMap}`,
      });
    }

    expect(
      delivery(cpu(file("mkv", dolbyVisionOf(8, 1)), castCapabilities("Chromecast Ultra"))),
    ).toBe("copy base");
  });

  it("never plays Dolby Vision 7 as stored, and copies it as its HDR10 base layer", () => {
    expect(ladder(qsv, dolbyVisionOf(7, 6))).toStrictEqual({
      "iphone mp4": "copy base",
      "iphone mkv": "copy base",
      "hdr browser mp4": "copy base",
      "hdr browser mkv": "copy base",
      "sdr browser mp4": "encode tonemap.qsv.placebo:pq",
    });
  });

  it("plays Dolby Vision 5 only for Dolby Vision, and maps it only with libplacebo", () => {
    expect(ladder(qsv, dolbyVisionOf(5, 0))).toStrictEqual({
      "iphone mp4": "direct",
      "iphone mkv": "copy only",
      "hdr browser mp4": "encode tonemap.qsv.placebo:pq",
      "hdr browser mkv": "encode tonemap.qsv.placebo:pq",
      "sdr browser mp4": "encode tonemap.qsv.placebo:pq",
    });
    expect(ladder(cpu, dolbyVisionOf(5, 0))).toStrictEqual({
      "iphone mp4": "direct",
      "iphone mkv": "copy only",
      "hdr browser mp4": "refused dolby-vision-not-convertible",
      "hdr browser mkv": "refused dolby-vision-not-convertible",
      "sdr browser mp4": "refused dolby-vision-not-convertible",
    });
  });

  it("reads profile 5 as profile 5 whatever compatibility id it claims", () => {
    for (const compatibility of [1, 2, 4, 6]) {
      expect(ladder(qsv, dolbyVisionOf(5, compatibility))).toStrictEqual(
        ladder(qsv, dolbyVisionOf(5, 0)),
      );
    }
  });

  it("refuses Dolby Vision 5 whose first picture has no RPU, everywhere", () => {
    const refused = "refused dolby-vision-not-convertible";

    for (const compatibility of [0, 1]) {
      expect(ladder(qsv, dolbyVisionOf(5, compatibility, false))).toStrictEqual({
        "iphone mp4": refused,
        "iphone mkv": refused,
        "hdr browser mp4": refused,
        "hdr browser mkv": refused,
        "sdr browser mp4": refused,
      });
    }
  });

  it("takes a profile and id the table does not name as the stricter kind: no base layer", () => {
    const strict = {
      "iphone mp4": "encode tonemap.qsv.placebo:pq",
      "iphone mkv": "encode tonemap.qsv.placebo:pq",
      "hdr browser mp4": "encode tonemap.qsv.placebo:pq",
      "hdr browser mkv": "encode tonemap.qsv.placebo:pq",
      "sdr browser mp4": "encode tonemap.qsv.placebo:pq",
    };

    for (const [profile, compatibility] of [
      [7, 1],
      [7, 2],
      [8, 0],
      [8, 6],
      [4, 2],
      [9, 2],
      [10, 1],
    ] as const) {
      expect(
        ladder(qsv, dolbyVisionOf(profile, compatibility)),
        `${String(profile)}.${String(compatibility)}`,
      ).toStrictEqual(strict);
    }

    expect(
      ladder(qsv, hevc10("dolby-vision", COLOURS.hdr10, { dolbyVisionRpu: true })),
    ).toStrictEqual(strict);
    expect(delivery(qsv(file("mkv", dolbyVisionOf(8, 6, false)), iphone))).toBe(
      "refused dolby-vision-not-convertible",
    );
  });

  it("tone-maps each base layer from what it is for an SDR client", () => {
    expect(sdrDelivery(qsvWithoutVulkan, hevc10("hdr10", COLOURS.hdr10))).toBe(
      "encode tonemap.qsv:pq",
    );
    expect(sdrDelivery(qsvWithoutVulkan, hevc10("hdr10", COLOURS.hdr10, { hdr10Plus: true }))).toBe(
      "encode tonemap.qsv:pq",
    );
    expect(sdrDelivery(qsvWithoutVulkan, hevc10("hlg", COLOURS.hlg))).toBe(
      "encode tonemap.qsv:hlg",
    );
    expect(sdrDelivery(qsvWithoutVulkan, dolbyVisionOf(8, 1))).toBe("encode tonemap.qsv:pq");
    expect(sdrDelivery(qsvWithoutVulkan, dolbyVisionOf(7, 6))).toBe("encode tonemap.qsv:pq");
    expect(sdrDelivery(qsvWithoutVulkan, dolbyVisionOf(8, 4))).toBe("encode tonemap.qsv:hlg");
    expect(sdrDelivery(qsvWithoutVulkan, dolbyVisionOf(8, 2))).toBe("encode");
  });

  it("refuses Dolby Vision 5 where no libplacebo is proven, rather than map its IPT as PQ", () => {
    expect(delivery(qsvWithoutVulkan(file("mkv", dolbyVisionOf(5, 0)), sdrBrowser))).toBe(
      "refused dolby-vision-not-convertible",
    );
    expect(delivery(cpu(file("mkv", hevc10("dolby-vision", COLOURS.ipt)), sdrBrowser))).toBe(
      "refused dolby-vision-not-convertible",
    );
  });
});

/** The video arguments of a copy's run that states Dolby Vision as `kept`. */
const copyArgs = (kept: DolbyVisionCopy): ReadonlyArray<string> => {
  const args = hlsCommand({
    input: "/media/a.mkv",
    sourceStart: 0,
    from: 0,
    videoIndex: 0,
    videoCodec: "hevc",
    video: VideoPlan.Copy({ dolbyVision: kept }),
    audio: AudioPlan.Copy({ index: 1 }),
    audioCodec: "aac",
    copiedAudioEnd: undefined,
    segmentStarts: [0, 4],
    files: {},
    previousStart: undefined,
    outputDirectory: "/transcode/s/1",
  }).args;

  const at = args.indexOf("-c:v");

  return args.slice(at, args.indexOf("-map", at));
};

describe("a refusal at the encode rung", () => {
  it("is one a negotiation decides again from evidence, as it does before any probe", () => {
    const evidenceFree = decidePlayback(file("mkv", dolbyVisionOf(5, 0)), sdrBrowser, {
      audioIndex: undefined,
      capabilities: { domains: [], verified: new Set(), excluded: new Set() },
    });

    expect(delivery(evidenceFree)).toBe("refused dolby-vision-not-convertible");
    expect(
      PlaybackPlan.$is("Unsupported")(evidenceFree) && ENCODE_REFUSALS.has(evidenceFree.reason),
    ).toBe(true);
  });
});

describe("a copy of Dolby Vision", () => {
  it("writes its configuration, in Dolby Vision's own sample entry for profile 5 alone", () => {
    expect(copyArgs("none")).toStrictEqual(["-c:v", "copy", "-tag:v", "hvc1"]);
    expect(copyArgs("base")).toStrictEqual([
      "-c:v",
      "copy",
      "-tag:v",
      "hvc1",
      "-bsf:v",
      "filter_units=remove_types=62|63",
    ]);
    expect(copyArgs("compatible")).toStrictEqual([
      "-c:v",
      "copy",
      "-tag:v",
      "hvc1",
      "-strict",
      "unofficial",
    ]);
    expect(copyArgs("only")).toStrictEqual([
      "-c:v",
      "copy",
      "-tag:v",
      "dvh1",
      "-strict",
      "unofficial",
    ]);
  });
});
