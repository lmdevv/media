import { assert, describe, expect, it } from "@effect/vitest";
import { ClientCapabilities } from "@media/contracts/media-playback";
import { Result, Schema } from "effect";
import * as fc from "fast-check";

import { decideDownload, DownloadPlan } from "../downloads/download-plan.ts";
import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import { verifiedFor } from "../testing/capability-snapshots.ts";
import { renderMultivariant } from "./hls-plan.ts";
import { variantOf } from "./hls-variant.ts";
import {
  AudioPlan,
  BurnRequest,
  decidePlayback,
  type DecisionOptions,
  outputTargets,
  PlaybackPlan,
  replan,
  VideoPlan,
} from "./playback-decision.ts";
import { hlsCommand } from "./transcode-command.ts";
import { summaryOf } from "./transcode-diagnostics.ts";
import { encodeDomain } from "./video-pipeline.ts";
import { type CapabilityKey, type GpuDomain, ImplId, Op } from "./video-ops.ts";

const PQ_COLOUR: VideoStream["colour"] = {
  transfer: "smpte2084",
  primaries: "bt2020",
  matrix: "bt2020nc",
  range: "limited",
  mastering: { minLuminance: 0.005, maxLuminance: 1000 },
  contentLight: { maxCll: 1000, maxFall: 400 },
};

const HLG_COLOUR: VideoStream["colour"] = {
  transfer: "arib-std-b67",
  primaries: "bt2020",
  matrix: "bt2020nc",
  range: "limited",
};

const SDR_COLOUR: VideoStream["colour"] = {
  transfer: "bt709",
  primaries: "bt709",
  matrix: "bt709",
  range: "limited",
};

/** A 4K 24 fps HEVC Main 10 stream of `dynamicRange` in `colour`. */
const hevc = (
  dynamicRange: VideoStream["dynamicRange"],
  colour: VideoStream["colour"],
  extra: Partial<VideoStream> = {},
): VideoStream => ({
  index: 0,
  codec: "hevc",
  profile: "Main 10",
  level: 153,
  pixelFormat: "yuv420p10le",
  bitDepth: 10,
  width: 3840,
  height: 2160,
  frameRate: 24,
  dynamicRange,
  fieldOrder: "progressive",
  colour,
  ...extra,
});

/** Each kind of source the table decides for that a re-encode may keep or map, by its kind. */
const SOURCES = {
  hdr10: hevc("hdr10", PQ_COLOUR),
  hdr10plus: hevc("hdr10", PQ_COLOUR, { hdr10Plus: true }),
  hlg: hevc("hlg", HLG_COLOUR),
  "dolby-vision-5": hevc("dolby-vision", undefined, {
    dolbyVision: { profile: 5, level: 6, compatibility: 0 },
    dolbyVisionRpu: true,
  }),
  "dolby-vision-7": hevc("dolby-vision", PQ_COLOUR, {
    dolbyVision: { profile: 7, level: 6, compatibility: 6 },
  }),
  "dolby-vision-8.1": hevc("dolby-vision", PQ_COLOUR, {
    dolbyVision: { profile: 8, level: 6, compatibility: 1 },
  }),
  "dolby-vision-8.2": hevc("dolby-vision", SDR_COLOUR, {
    dolbyVision: { profile: 8, level: 6, compatibility: 2 },
  }),
  "dolby-vision-8.4": hevc("dolby-vision", HLG_COLOUR, {
    dolbyVision: { profile: 8, level: 4, compatibility: 4 },
  }),
  sdr: hevc("sdr", SDR_COLOUR, { profile: "Main", pixelFormat: "yuv420p", bitDepth: 8 }),
} as const satisfies Record<string, VideoStream>;

const aac: AudioTrack = { index: 1, codec: "aac", profile: "LC", channels: 2, default: true };

const probe = (video: VideoStream, extra: Partial<MediaProbe> = {}): MediaProbe => ({
  container: "mkv",
  formatName: "matroska,webm",
  durationSeconds: 600,
  startSeconds: 0,
  bitRate: 40_000_000,
  video,
  audio: [aac],
  subtitles: [],
  chapters: [],
  ...extra,
});

/** A device on HLS with AAC that plays `videoCodecs` on a screen that shows `hdrScreen`. */
const client = (
  videoCodecs: ClientCapabilities["videoCodecs"],
  hdrScreen: ClientCapabilities["hdrScreen"],
): ClientCapabilities => ({
  containers: ["mp4", "mov"],
  videoCodecs,
  audioCodecs: [{ codec: "aac", maxChannels: 8 }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
  hdrScreen,
});

/** What an iPhone plays: H.264, and HEVC Main and Main 10 in HDR10, HLG, and Dolby Vision. */
const IPHONE_CODECS: ClientCapabilities["videoCodecs"] = [
  { codec: "h264", maxLevel: 52, maxBitDepth: 8, powerEfficient: true },
  {
    codec: "hevc",
    profiles: ["Main", "Main 10"],
    maxBitDepth: 10,
    dynamicRanges: ["hdr10", "hlg", "dolby-vision"],
    powerEfficient: true,
  },
];

/** An iPhone on its own HDR screen. */
const iphone = client(IPHONE_CODECS, ["hdr10", "hlg"]);

/** The same iPhone mirrored to an SDR screen: it still decodes HDR, which it would tone-map. */
const sdrScreen = client(IPHONE_CODECS, undefined);

/** A device that plays HEVC Main 10 in HDR10 and HLG on an HDR screen, and nothing else. */
const hevcOnly = client(
  [
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg"],
    },
  ],
  ["hdr10", "hlg"],
);

/** A cap that makes every 4K source encode. */
const CAPPED = { quality: { maxHeight: 1080 } } as const;

/** Decides on a server whose `domains` and CPU verified everything, except what `refused` picks. */
const decide = (
  domains: ReadonlyArray<GpuDomain>,
  media: MediaProbe,
  viewer: ClientCapabilities,
  extra: Partial<DecisionOptions> = {},
  refused: (key: CapabilityKey) => boolean = () => false,
) =>
  decidePlayback(media, viewer, {
    audioIndex: undefined,
    capabilities: verifiedFor(media, domains, refused),
    ...extra,
  });

type Encoded = Extract<VideoPlan, { readonly _tag: "Encode" }>;

const encodedOf = (plan: PlaybackPlan): Encoded => {
  if (!PlaybackPlan.$is("Hls")(plan) || !VideoPlan.$is("Encode")(plan.video)) {
    throw new Error(`not an encode: ${JSON.stringify(plan)}`);
  }

  return plan.video;
};

/** What an encode delivers and where: codec, range, height, encode key, and whether it tone-maps. */
const delivery = (plan: PlaybackPlan) => {
  const encoded = encodedOf(plan);

  return {
    codec: encoded.output.codec,
    range: encoded.output.dynamicRange,
    height: encoded.output.height,
    encode: encoded.pipeline.steps.at(-1)?.capability,
    toneMaps: encoded.pipeline.steps.some((step) => Op.$is("ToneMap")(step.op)),
  };
};

/** What a replanned encode delivers, as a Quick Sync stream's plan. */
const deliver = (video: Encoded) =>
  delivery(PlaybackPlan.Hls({ mode: "transcode-qsv", video, audio: AudioPlan.None() }));

/** The video filters and encoder of the HDR10 source's run on `domain`, capped to 1080 lines. */
const argsOn = (domain: "qsv" | "vaapi" | "cpu") => {
  const video = encodedOf(
    decide(
      domain === "cpu" ? [] : [domain],
      probe(SOURCES.hdr10),
      domain === "cpu" ? hevcOnly : iphone,
      CAPPED,
    ),
  );

  const args = hlsCommand({
    input: "/media/Film (2021).mkv",
    sourceStart: 0,
    from: 0,
    videoIndex: 0,
    videoCodec: "hevc",
    video,
    audio: AudioPlan.Copy({ index: 1 }),
    audioCodec: "aac",
    copiedAudioEnd: undefined,
    segmentStarts: [0, 4],
    files: {},
    previousStart: undefined,
    outputDirectory: "/tmp/stream/1",
  }).args;

  return {
    filters: args[args.indexOf("-vf") + 1],
    encoder: args.slice(args.indexOf("-c:v"), args.indexOf("-force_key_frames")),
  };
};

describe("the HDR target", () => {
  it("keeps the source's HDR10 or HLG, as its base layer, on each GPU and the CPU", () => {
    const kept = [
      ["hdr10", "hdr10"],
      ["hdr10plus", "hdr10"],
      ["dolby-vision-7", "hdr10"],
      ["dolby-vision-8.1", "hdr10"],
      ["hlg", "hlg"],
      ["dolby-vision-8.4", "hlg"],
    ] as const;

    for (const [kind, range] of kept) {
      const source = SOURCES[kind];
      const transfer = range === "hdr10" ? "pq" : "hlg";

      for (const domain of ["qsv", "vaapi"] as const) {
        expect(delivery(decide([domain], probe(source), iphone, CAPPED)), kind).toStrictEqual({
          codec: "hevc",
          range,
          height: 1080,
          encode: `encode.${domain}.hevc:10/cbr/${transfer}`,
          toneMaps: false,
        });
      }

      expect(delivery(decide([], probe(source), hevcOnly, CAPPED)), kind).toStrictEqual({
        codec: "hevc",
        range,
        height: 1080,
        encode: `encode.cpu.hevc:10/crf/${transfer}`,
        toneMaps: false,
      });
    }
  });

  it("maps to SDR every kind the table keeps no HDR of", () => {
    expect(
      delivery(decide(["qsv"], probe(SOURCES["dolby-vision-5"]), iphone, CAPPED)),
    ).toMatchObject({
      range: "sdr",
      encode: "encode.qsv.hevc:8/cbr",
      toneMaps: true,
    });

    for (const kind of ["dolby-vision-8.2", "sdr"] as const) {
      expect(delivery(decide(["qsv"], probe(SOURCES[kind]), iphone, CAPPED)), kind).toStrictEqual({
        codec: "hevc",
        range: "sdr",
        height: 1080,
        encode: "encode.qsv.hevc:8/cbr",
        toneMaps: false,
      });
    }
  });

  it("is never offered to a screen that does not show the source's HDR", () => {
    const toSdr = delivery(decide(["qsv"], probe(SOURCES.hdr10), sdrScreen, CAPPED));

    expect(toSdr).toStrictEqual({
      codec: "hevc",
      range: "sdr",
      height: 1080,
      encode: "encode.qsv.hevc:8/cbr",
      toneMaps: true,
    });
    expect(
      delivery(decide(["qsv"], probe(SOURCES.hlg), client(IPHONE_CODECS, ["hdr10"]), CAPPED)),
    ).toMatchObject({ range: "sdr", toneMaps: true });
    // A client that lists HLG for its screen but not for HEVC does not play HLG HEVC.
    expect(
      delivery(
        decide(
          ["qsv"],
          probe(SOURCES.hlg),
          client(
            [{ codec: "h264" }, { codec: "hevc", maxBitDepth: 10, dynamicRanges: ["hdr10"] }],
            ["hdr10", "hlg"],
          ),
          CAPPED,
        ),
      ),
    ).toMatchObject({ range: "sdr", toneMaps: true });
  });

  it("plans a client that shows no HDR, and every SDR source, as without the target", () => {
    const codecs = fc.subarray([
      { codec: "h264" },
      { codec: "h264", maxLevel: 41 },
      { codec: "hevc" },
      { codec: "hevc", profiles: ["Main"] },
      { codec: "hevc", profiles: ["Main 10"], maxBitDepth: 10 },
      { codec: "hevc", maxBitDepth: 10, dynamicRanges: ["hdr10", "hlg"], maxLevel: 153 },
      { codec: "av1", powerEfficient: true },
      { codec: "av1", maxBitDepth: 10, dynamicRanges: ["hdr10"] },
    ] as const);

    fc.assert(
      fc.property(
        codecs,
        fc.constantFrom("hdr10", "hlg", undefined),
        fc.constantFrom(undefined, [] as const, ["hdr10", "hlg"] as const),
        (videoCodecs, kept, hdrScreen) => {
          const device = client(videoCodecs, hdrScreen);
          const sdr = outputTargets(device, undefined);
          const targets = outputTargets(device, kept);

          // Without a screen that shows HDR, or from a source with none, the ladder is SDR's;
          // with both, at most an HDR target comes first, before SDR's ladder unchanged.
          if (hdrScreen === undefined || hdrScreen.length === 0 || kept === undefined) {
            expect(targets).toStrictEqual(sdr);
          } else {
            expect(targets.filter((target) => target.colour === "sdr")).toStrictEqual(sdr);
            expect(
              targets.slice(0, targets.length - sdr.length).map((target) => target.colour),
            ).toStrictEqual(targets.length > sdr.length ? [kept] : []);
          }
        },
      ),
    );
  });

  it("keeps a copy's precedence: an HDR original the client plays is never encoded", () => {
    const plan = decide(["qsv"], probe(SOURCES.hdr10), iphone);

    assert.isTrue(PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Copy")(plan.video));
  });

  it("encodes HDR on the CPU only for a client that plays nothing but HEVC", () => {
    const plan = decide([], probe(SOURCES.hdr10), iphone, CAPPED);

    expect(delivery(plan)).toMatchObject({ codec: "h264", range: "sdr", toneMaps: true });
    expect(summaryOf(encodedOf(plan), [], 0, SOURCES.hdr10).sdrReason).toBe("no-hdr-encode");
  });

  it("maps to SDR, and says why, where no proven HDR encode is left or a subtitle is drawn in", () => {
    const unproven = decide(["qsv"], probe(SOURCES.hdr10), iphone, CAPPED, (key) =>
      key.startsWith("encode.qsv.hevc:10/"),
    );

    expect(delivery(unproven)).toMatchObject({
      range: "sdr",
      encode: "encode.qsv.hevc:8/cbr",
      toneMaps: true,
    });
    expect(summaryOf(encodedOf(unproven), [], 0, SOURCES.hdr10).sdrReason).toBe("no-hdr-encode");

    const subtitled = probe(SOURCES.hdr10, {
      subtitles: [
        {
          index: 2,
          codec: "hdmv_pgs_subtitle",
          kind: "bitmap",
          default: false,
          forced: false,
          hearingImpaired: false,
        },
      ],
    });

    const burned = decide(["qsv"], subtitled, iphone, {
      burnSubtitle: BurnRequest.Image({ stream: 2 }),
    });

    expect(delivery(burned)).toMatchObject({ range: "sdr", toneMaps: true });
    expect(summaryOf(encodedOf(burned), [], 0, SOURCES.hdr10).sdrReason).toBe("subtitle");

    const kept = decide(["qsv"], probe(SOURCES.hdr10), iphone, CAPPED);

    expect(summaryOf(encodedOf(kept), [], 0, SOURCES.hdr10)).not.toHaveProperty("sdrReason");
    expect(
      summaryOf(
        encodedOf(decide(["qsv"], probe(SOURCES.hdr10), sdrScreen, CAPPED)),
        [],
        0,
        SOURCES.hdr10,
      ),
    ).not.toHaveProperty("sdrReason");
  });

  it("replans a failed HDR run within its intent, to SDR, as recovery does", () => {
    const media = probe(SOURCES.hdr10);
    const kept = encodedOf(decide(["qsv"], media, iphone, CAPPED));
    const snapshot = verifiedFor(media, ["qsv"]);

    // A probe reproduced the HDR encode's failure: that key alone is quarantined.
    const quarantined = replan(SOURCES.hdr10, kept.intent, {
      ...snapshot,
      verified: new Set(
        [...snapshot.verified].filter((key) => !key.startsWith("encode.qsv.hevc:10/")),
      ),
    });

    // Only this file failed there: the stream keeps off the HEVC row.
    const excluded = replan(SOURCES.hdr10, kept.intent, {
      ...snapshot,
      excluded: new Set([ImplId("encode.qsv.hevc")]),
    });

    const replanned = (result: typeof quarantined): Encoded =>
      Result.getOrThrowWith(result, (reason) => new Error(reason));

    expect(deliver(replanned(quarantined))).toMatchObject({
      codec: "hevc",
      range: "sdr",
      toneMaps: true,
    });
    expect(deliver(replanned(excluded))).toMatchObject({
      codec: "h264",
      range: "sdr",
      toneMaps: true,
    });
    expect(summaryOf(replanned(excluded), [], 1, SOURCES.hdr10).sdrReason).toBe("no-hdr-encode");
  });

  it("states the lowest level that holds the encode, and names it in the variant", () => {
    const constraints = { qsv: "90", vaapi: "B0", cpu: "90" } as const;

    for (const domain of ["qsv", "vaapi", "cpu"] as const) {
      const plan = decide(
        domain === "cpu" ? [] : [domain],
        probe(SOURCES.hdr10),
        domain === "cpu" ? hevcOnly : iphone,
        CAPPED,
      );

      const encoded = encodedOf(plan);
      const encode = encoded.pipeline.steps.at(-1)?.op;

      // 1920x1080 at 24 fps and HEVC's 6 Mb/s: level 4.0, the lowest that holds it.
      assert.isTrue(encode !== undefined && Op.$is("Encode")(encode) && encode.level === 120);
      expect(encodeDomain(encoded.pipeline)).toBe(domain);
      expect(variantOf(encoded, AudioPlan.Copy({ index: 1 }), aac)?.codecs).toStrictEqual([
        `hvc1.2.4.L120.${constraints[domain]}`,
        "mp4a.40.2",
      ]);
    }
  });

  it("renders each path's HDR chain: Main 10 at the stated level, in the source's colour, no tone map", () => {
    expect(argsOn("qsv")).toStrictEqual({
      filters:
        "hwmap,format=qsv,vpp_qsv=w=1920:h=1080:format=p010:out_color_matrix=bt2020nc:out_color_primaries=bt2020:out_color_transfer=smpte2084,fps=source_fps",
      encoder: [
        "-c:v",
        "hevc_qsv",
        "-preset",
        "veryfast",
        "-profile:v",
        "main10",
        "-tier",
        "main",
        "-level",
        "40",
        "-b:v",
        "6000000",
        "-maxrate",
        "6000000",
        "-bufsize",
        "12000000",
        "-forced_idr",
        "1",
        "-tag:v",
        "hvc1",
      ],
    });
    expect(argsOn("vaapi")).toStrictEqual({
      filters: "scale_vaapi=w=1920:h=1080:format=p010",
      encoder: [
        "-c:v",
        "hevc_vaapi",
        "-profile:v",
        "main10",
        "-level",
        "120",
        "-b:v",
        "6000000",
        "-maxrate",
        "6000000",
        "-bufsize",
        "12000000",
        "-tag:v",
        "hvc1",
      ],
    });
    expect(argsOn("cpu")).toStrictEqual({
      filters: [
        "scale=1920:1080:flags=bicubic",
        "format=yuv420p10le",
        "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS",
        "sidedata=mode=delete:type=DYNAMIC_HDR_VIVID",
        "sidedata=mode=delete:type=DOVI_METADATA",
        "sidedata=mode=delete:type=DOVI_RPU_BUFFER",
      ].join(","),
      encoder: [
        "-c:v",
        "libx265",
        "-preset",
        "superfast",
        "-profile:v",
        "main10",
        "-crf",
        "23",
        "-maxrate",
        "6000000",
        "-bufsize",
        "12000000",
        "-forced-idr",
        "1",
        "-x265-params",
        "log-level=error:open-gop=0:level-idc=40",
        "-tag:v",
        "hvc1",
      ],
    });
  });

  it("is served as a multivariant playlist of one variant that states its range", () => {
    const pq = encodedOf(decide(["vaapi"], probe(SOURCES.hdr10), iphone, CAPPED));
    const hlg = encodedOf(decide(["qsv"], probe(SOURCES.hlg), iphone, CAPPED));
    const variant = variantOf(pq, AudioPlan.Aac({ index: 1 }), aac);

    assert.isDefined(variant);
    expect(renderMultivariant(variant, "video.m3u8?t=1")).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-STREAM-INF:BANDWIDTH=9192000,AVERAGE-BANDWIDTH=6192000,CODECS="hvc1.2.4.L120.B0,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=24.000,VIDEO-RANGE=PQ',
        "video.m3u8?t=1",
        "",
      ].join("\n"),
    );
    expect(variantOf(hlg, AudioPlan.None(), undefined)).toMatchObject({
      codecs: ["hvc1.2.4.L120.90"],
      videoRange: "HLG",
    });
    expect(
      variantOf(
        encodedOf(decide(["qsv"], probe(SOURCES.hdr10), sdrScreen, CAPPED)),
        AudioPlan.None(),
        undefined,
      ),
    ).toBeUndefined();
  });

  it("leaves downloads SDR, whatever screen the device declares", () => {
    const download = decideDownload(probe(SOURCES.hdr10), iphone, "standard", {
      audioIndex: undefined,
      capabilities: verifiedFor(probe(SOURCES.hdr10), ["qsv"]),
      sizeBytes: 4_000_000_000,
    });

    assert.isTrue(DownloadPlan.$is("Mp4")(download) && VideoPlan.$is("Encode")(download.video));
    expect(
      DownloadPlan.$is("Mp4")(download) && VideoPlan.$is("Encode")(download.video)
        ? download.video.output.dynamicRange
        : undefined,
    ).toBe("sdr");
  });

  it("decodes a screen's HDR format it does not know, and matches nothing with it", () => {
    const decoded = Schema.decodeSync(ClientCapabilities)({
      containers: ["mp4"],
      videoCodecs: IPHONE_CODECS,
      audioCodecs: [{ codec: "aac" }],
      maxWidth: 3840,
      maxHeight: 2160,
      hls: true,
      mse: false,
      hdrScreen: ["hlg", "hdr10-plus-pro"],
    });

    expect(decoded.hdrScreen).toStrictEqual(["hlg", "hdr10-plus-pro"]);
    expect(delivery(decide(["qsv"], probe(SOURCES.hdr10), decoded, CAPPED))).toMatchObject({
      range: "sdr",
    });
    expect(delivery(decide(["qsv"], probe(SOURCES.hlg), decoded, CAPPED))).toMatchObject({
      range: "hlg",
    });
  });
});
