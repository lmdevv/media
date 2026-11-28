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

/** A 4K HEVC Main 10 stream of `dynamicRange` in `colour`, with what `extra` adds. */
const hevc10 = (
  dynamicRange: VideoStream["dynamicRange"],
  colour: VideoColour,
  extra: Pick<VideoStream, "hdr10Plus" | "dolbyVision"> = {},
): VideoStream => ({
  index: 0,
  codec: "hevc",
  profile: "Main 10",
  level: 153,
  bitDepth: 10,
  pixelFormat: "yuv420p10le",
  width: 3840,
  height: 2160,
  dynamicRange,
  colour,
  hdr10Plus: extra.hdr10Plus,
  dolbyVision: extra.dolbyVision,
});

const dolbyVisionOf = (profile: number, compatibility: number): VideoStream =>
  hevc10("dolby-vision", BASE_COLOURS.get(compatibility) ?? COLOURS.ipt, {
    dolbyVision: { profile, level: 6, compatibility },
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

describe("what each kind of source gets", () => {
  it("copies Dolby Vision to a client that plays it, keeping its configuration", () => {
    expect(delivery(cpu(file("mkv", dolbyVisionOf(8, 1)), iphone))).toBe("copy compatible");
    expect(delivery(cpu(file("mkv", dolbyVisionOf(8, 4)), iphone))).toBe("copy compatible");
    expect(delivery(cpu(file("mkv", dolbyVisionOf(5, 0)), iphone))).toBe("copy only");
    expect(delivery(cpu(file("mp4", dolbyVisionOf(5, 0)), iphone))).toBe("direct");
  });

  it("copies profile 7 as its HDR10 base layer, without its configuration", () => {
    expect(delivery(cpu(file("mkv", dolbyVisionOf(7, 6)), iphone))).toBe("copy none");
    expect(delivery(cpu(file("mkv", dolbyVisionOf(7, 6)), hdrBrowser))).toBe("copy none");
  });

  it("copies a Dolby Vision base layer to a client that plays what it is", () => {
    expect(delivery(cpu(file("mkv", dolbyVisionOf(8, 1)), hdrBrowser))).toBe("copy none");
    expect(delivery(cpu(file("mkv", dolbyVisionOf(8, 4)), hdrBrowser))).toBe("copy none");
    expect(
      delivery(cpu(file("mkv", dolbyVisionOf(8, 1)), castCapabilities("Chromecast Ultra"))),
    ).toBe("copy none");
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

  it("maps every HDR kind with libplacebo where the GPU proved it", () => {
    expect(sdrDelivery(qsv, hevc10("hdr10", COLOURS.hdr10))).toBe("encode tonemap.qsv.placebo:pq");
    expect(sdrDelivery(qsv, hevc10("hlg", COLOURS.hlg))).toBe("encode tonemap.qsv.placebo:hlg");
    expect(sdrDelivery(qsv, dolbyVisionOf(8, 4))).toBe("encode tonemap.qsv.placebo:hlg");
    expect(sdrDelivery(qsv, dolbyVisionOf(5, 0))).toBe("encode tonemap.qsv.placebo:pq");
    expect(sdrDelivery(qsv, hevc10("dolby-vision", COLOURS.ipt))).toBe(
      "encode tonemap.qsv.placebo:pq",
    );
  });

  it("refuses Dolby Vision 5 where no libplacebo is proven, rather than map its IPT as PQ", () => {
    expect(delivery(qsvWithoutVulkan(file("mkv", dolbyVisionOf(5, 0)), sdrBrowser))).toBe(
      "refused dolby-vision-not-convertible",
    );
    expect(delivery(cpu(file("mkv", dolbyVisionOf(5, 0)), hdrBrowser))).toBe(
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

describe("a copy that keeps Dolby Vision", () => {
  it("writes its configuration, in Dolby Vision's own sample entry for profile 5 alone", () => {
    expect(copyArgs("none")).toStrictEqual(["-c:v", "copy", "-tag:v", "hvc1"]);
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
