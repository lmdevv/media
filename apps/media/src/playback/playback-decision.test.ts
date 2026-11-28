import { assert, describe, expect, it } from "@effect/vitest";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import { Effect, Result, Schema } from "effect";

import {
  type AudioTrack,
  type MediaProbe,
  parseFfprobeJson,
  type VideoStream,
} from "../media/media-probe.ts";
import { verifiedFor, withoutToneMaps } from "../testing/capability-snapshots.ts";
import {
  AudioPlan,
  BurnRequest,
  decidePlayback,
  type DecisionOptions,
  encodeIntent,
  outputTargets,
  PlaybackPlan,
  replan,
  VideoPlan,
} from "./playback-decision.ts";
import { levelOf } from "./output-levels.ts";
import { encodeDomain } from "./video-pipeline.ts";
import { type CapabilityKey, type GpuDomain, ImplId, Op, type OutputTarget } from "./video-ops.ts";

interface VideoOptions {
  readonly profile?: string;
  readonly bitDepth?: number;
  readonly width?: number;
  readonly height?: number;
  readonly dynamicRange?: VideoStream["dynamicRange"];
  readonly frameRate?: number;
  readonly fieldOrder?: VideoStream["fieldOrder"];
}

const video = (codec: string, options: VideoOptions = {}): VideoStream => ({
  index: 0,
  codec,
  profile: options.profile ?? "High",
  level: 41,
  bitDepth: options.bitDepth ?? 8,
  width: options.width ?? 1920,
  height: options.height ?? 1080,
  dynamicRange: options.dynamicRange ?? "sdr",
  frameRate: options.frameRate,
  fieldOrder: options.fieldOrder,
});

const h264 = video("h264");

const hevcHdr = video("hevc", {
  profile: "Main 10",
  bitDepth: 10,
  width: 3840,
  height: 2160,
  dynamicRange: "hdr10",
});

const audio = (index: number, codec: string, channels: number, isDefault: boolean): AudioTrack => ({
  index,
  codec,
  channels,
  default: isDefault,
});

const aac = audio(1, "aac", 2, true);

const eac3 = audio(2, "eac3", 6, false);

const probe = (
  container: MediaProbe["container"],
  stream: VideoStream,
  tracks: ReadonlyArray<AudioTrack>,
  durationSeconds = 600,
  extra: Pick<MediaProbe, "bitRate"> & { readonly subtitles?: MediaProbe["subtitles"] } = {},
): MediaProbe => ({
  container,
  formatName: container,
  durationSeconds,
  startSeconds: 0,
  bitRate: extra.bitRate,
  video: stream,
  audio: tracks,
  subtitles: extra.subtitles ?? [],
  chapters: [],
});

interface ClientOptions {
  readonly containers?: ClientCapabilities["containers"];
  readonly videoCodecs?: ClientCapabilities["videoCodecs"];
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly adaptive?: boolean;
}

const chromeCodecs: ClientCapabilities["videoCodecs"] = [
  { codec: "h264" },
  { codec: "vp9" },
  { codec: "av1", maxBitDepth: 10 },
];

const chromeLike = (options: ClientOptions = {}): ClientCapabilities => ({
  containers: options.containers ?? ["mp4", "webm"],
  videoCodecs: options.videoCodecs ?? chromeCodecs,
  audioCodecs: [{ codec: "aac" }, { codec: "opus" }, { codec: "mp3" }],
  maxWidth: options.maxWidth ?? 3840,
  maxHeight: options.maxHeight ?? 2160,
  hls: false,
  mse: options.adaptive ?? true,
});

const chrome = chromeLike();

const safari: ClientCapabilities = {
  containers: ["mp4", "mov"],
  videoCodecs: [
    { codec: "h264" },
    { codec: "hevc", maxBitDepth: 10, dynamicRanges: ["hdr10", "hlg", "dolby-vision"] },
  ],
  audioCodecs: [{ codec: "aac" }, { codec: "ac3" }, { codec: "eac3", maxChannels: 8 }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

type Extra = Omit<DecisionOptions, "audioIndex" | "capabilities"> & {
  readonly audioIndex?: number;
};

/**
 * Decides on a server whose `domains` and CPU verified everything a chain could use, except the
 * keys `refused` picks.
 */
const deciding =
  (domains: ReadonlyArray<GpuDomain>, refused: (key: CapabilityKey) => boolean) =>
  (media: MediaProbe, client: ClientCapabilities, extra: Extra = {}) =>
    decidePlayback(media, client, {
      audioIndex: undefined,
      capabilities: verifiedFor(media, domains, refused),
      ...extra,
    });

/** The CPU alone, without the filters software tone mapping needs. */
const software = deciding([], withoutToneMaps);

/** The CPU alone, tone mapping with `zscale` and `tonemap`. */
const cpuToneMap = deciding([], () => false);

/** Quick Sync and the CPU, tone mapping only on the GPU. */
const hardware = deciding(["qsv"], (key) => key.startsWith("tonemap.cpu"));

/** VA-API and the CPU, tone mapping only on the GPU. */
const vaapi = deciding(["vaapi"], (key) => key.startsWith("tonemap.cpu"));

const impls = (plan: PlaybackPlan): ReadonlyArray<string> =>
  PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Encode")(plan.video)
    ? plan.video.pipeline.steps.map((step) => step.impl)
    : [];

/** The capability the plan's encode step exercises, such as `encode.qsv.hevc:8/cbr`. */
const encodeKey = (plan: PlaybackPlan): string | undefined =>
  PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Encode")(plan.video)
    ? plan.video.pipeline.steps.at(-1)?.capability
    : undefined;

/** A device that decodes `codecs` and nothing else, over HLS, with AAC. */
const device = (videoCodecs: ClientCapabilities["videoCodecs"]): ClientCapabilities => ({
  containers: ["mp4"],
  videoCodecs,
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
});

const hevcOnly = device([{ codec: "hevc", profiles: ["Main"] }]);

const av1Only = device([{ codec: "av1", profiles: ["Main"] }]);

/** An Intel Mac's Chrome: H.264 and HEVC in hardware, AV1 in software. */
const chromeWithHevc = chromeLike({
  videoCodecs: [{ codec: "h264" }, { codec: "hevc" }, { codec: "av1", powerEfficient: false }],
});

/** Chrome on a GPU that decodes AV1. */
const chromeWithAv1 = chromeLike({
  videoCodecs: [{ codec: "h264" }, { codec: "av1", powerEfficient: true }],
});

const target = (
  codec: OutputTarget["codec"],
  cpuEncode: OutputTarget["cpuEncode"],
  level?: number,
): OutputTarget => ({ codec, depth: 8, colour: "sdr", cpuEncode, level });

/** An 8-bit MPEG-2 file no client plays, so every one of them needs an encode. */
const mpeg2 = probe("ts", video("mpeg2video", { profile: "Main" }), [aac]);

/** Quick Sync, VA-API, and the CPU, all verified. */
const everywhere = deciding(["qsv", "vaapi"], () => false);

describe("outputTargets", () => {
  it("prefers HEVC, then AV1 decoded in hardware, then H.264", () => {
    expect(outputTargets(chrome)).toStrictEqual([target("h264", "allowed")]);
    expect(outputTargets(safari)).toStrictEqual([
      target("hevc", "refused"),
      target("h264", "allowed"),
    ]);
    expect(outputTargets(chromeWithHevc)).toStrictEqual([
      target("hevc", "refused"),
      target("h264", "allowed"),
    ]);
    expect(outputTargets(chromeWithAv1)).toStrictEqual([
      target("av1", "refused"),
      target("h264", "allowed"),
    ]);
    expect(
      outputTargets(
        device([{ codec: "h264" }, { codec: "hevc" }, { codec: "av1", powerEfficient: true }]),
      ),
    ).toStrictEqual([
      target("hevc", "refused"),
      target("av1", "refused"),
      target("h264", "allowed"),
    ]);
  });

  it("encodes HEVC or AV1 on the CPU only for a client without H.264", () => {
    expect(outputTargets(hevcOnly)).toStrictEqual([target("hevc", "allowed")]);
    expect(outputTargets(av1Only)).toStrictEqual([target("av1", "allowed")]);
    expect(
      outputTargets(device([{ codec: "hevc" }, { codec: "av1", powerEfficient: true }])),
    ).toStrictEqual([target("hevc", "allowed"), target("av1", "allowed")]);
  });

  it("offers only a profile the client lists, and nothing for a client that plays none", () => {
    expect(
      outputTargets(device([{ codec: "h264" }, { codec: "hevc", profiles: ["Main 10"] }])),
    ).toStrictEqual([target("h264", "allowed")]);
    expect(outputTargets(device([{ codec: "h264", profiles: ["Main", "High"] }]))).toStrictEqual([
      target("h264", "allowed"),
    ]);
    expect(outputTargets(device([{ codec: "vp9" }]))).toStrictEqual([]);
  });

  it("carries the level the client declared for each codec", () => {
    expect(
      outputTargets(
        device([
          { codec: "h264", maxLevel: 41 },
          { codec: "hevc", maxLevel: 93 },
          { codec: "av1", maxLevel: 8, powerEfficient: true },
        ]),
      ),
    ).toStrictEqual([
      target("hevc", "refused", 93),
      target("av1", "refused", 8),
      target("h264", "allowed", 41),
    ]);
  });
});

describe("output codec", () => {
  it("leaves direct play, remuxes, and audio conversions to an HEVC client alone", () => {
    const hevc = video("hevc", { profile: "Main" });

    expect(everywhere(probe("mp4", hevc, [aac]), safari)).toStrictEqual(
      PlaybackPlan.Direct({ audioIndex: 1 }),
    );
    expect(everywhere(probe("mkv", hevc, [aac]), safari)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "remux",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Copy({ index: 1 }),
      }),
    );
    expect(everywhere(probe("mkv", h264, [audio(1, "dts", 6, true)]), safari)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "audio-transcode",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Aac({ index: 1 }),
      }),
    );
  });

  it("encodes HEVC on the GPU for a client that plays it, at three quarters of H.264's bitrate", () => {
    const plan = hardware(mpeg2, safari);

    expect(plan).toMatchObject({
      mode: "transcode-qsv",
      video: { output: { codec: "hevc", width: 1920, height: 1080, bitrate: 6_000_000 } },
    });
    expect(encodeKey(plan)).toBe("encode.qsv.hevc:8/cbr");
    expect(encodeKey(vaapi(mpeg2, chromeWithHevc))).toBe("encode.vaapi.hevc:8/cbr");
  });

  it("encodes AV1 on the GPU for a client that decodes it in hardware or plays only AV1", () => {
    expect(hardware(mpeg2, chromeWithAv1)).toMatchObject({
      mode: "transcode-qsv",
      video: { output: { codec: "av1", bitrate: 5_200_000 } },
    });
    expect(encodeKey(hardware(mpeg2, av1Only))).toBe("encode.qsv.av1:8/cbr");
    expect(encodeKey(hardware(mpeg2, chromeWithHevc))).toBe("encode.qsv.hevc:8/cbr");
  });

  it("encodes H.264 on a CPU for a client that plays it, and HEVC or AV1 only for one that does not", () => {
    expect(software(mpeg2, safari)).toMatchObject({
      mode: "transcode-software",
      video: { output: { codec: "h264", bitrate: 8_000_000 } },
    });
    expect(software(mpeg2, chromeWithAv1)).toMatchObject({ video: { output: { codec: "h264" } } });
    expect(encodeKey(software(mpeg2, hevcOnly))).toBe("encode.cpu.hevc:8/crf");
    expect(encodeKey(software(mpeg2, av1Only))).toBe("encode.cpu.av1:8/crf");
  });

  it("falls to the next target when an encoder is not verified", () => {
    const noHevcOnQsv = deciding(["qsv"], (key) => key === "encode.qsv.hevc:8/cbr");

    expect(encodeKey(noHevcOnQsv(mpeg2, safari))).toBe("encode.qsv.h264:8/cbr");

    const noHevcOnAnyGpu = deciding(["qsv", "vaapi"], (key) =>
      /^encode\.(qsv|vaapi)\.hevc:/u.test(key),
    );

    expect(encodeKey(noHevcOnAnyGpu(mpeg2, safari))).toBe("encode.qsv.h264:8/cbr");
    expect(encodeKey(noHevcOnAnyGpu(mpeg2, hevcOnly))).toBe("encode.cpu.hevc:8/crf");

    const noQsvHevc = deciding(["qsv", "vaapi"], (key) => key === "encode.qsv.hevc:8/cbr");

    expect(encodeKey(noQsvHevc(mpeg2, safari))).toBe("encode.vaapi.hevc:8/cbr");

    const noSoftwareHevc = deciding([], (key) => key === "encode.cpu.hevc:8/crf");

    expect(noSoftwareHevc(mpeg2, hevcOnly)).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "no-transcode-target" }),
    );
  });

  it("sizes an HEVC encode within the level the client declared", () => {
    const level31 = device([{ codec: "hevc", maxLevel: 93 }]);
    const plan = hardware(mpeg2, level31);

    expect(plan).toMatchObject({ video: { output: { codec: "hevc" } } });

    const output =
      PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Encode")(plan.video)
        ? plan.video.output
        : undefined;

    assert.isDefined(output);
    assert.isAtMost(output.width * output.height, 983_040);
    assert.closeTo(output.width / output.height, 1920 / 1080, 0.01);
  });
});

describe("decidePlayback", () => {
  it("plays compatible files directly", () => {
    expect(software(probe("mp4", h264, [aac]), chrome)).toStrictEqual(
      PlaybackPlan.Direct({ audioIndex: 1 }),
    );
    expect(software(probe("mp4", hevcHdr, [eac3]), safari)).toStrictEqual(
      PlaybackPlan.Direct({ audioIndex: 2 }),
    );
  });

  it("remuxes when only the container is unsupported", () => {
    expect(software(probe("mkv", h264, [aac]), chrome)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "remux",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Copy({ index: 1 }),
      }),
    );
  });

  it("remuxes to play a non-default audio track", () => {
    const twoTracks = probe("mp4", h264, [aac, audio(3, "aac", 2, false)]);

    expect(software(twoTracks, chrome, { audioIndex: 3 })).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "remux",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Copy({ index: 3 }),
      }),
    );
  });

  it("transcodes only the audio when the client lacks its codec", () => {
    expect(software(probe("mkv", h264, [eac3]), chrome)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "audio-transcode",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Aac({ index: 2 }),
      }),
    );
  });

  it("copies an interlaced stream the client plays, as it is, before any encode", () => {
    const interlaced = video("h264", { fieldOrder: "tff", width: 1440, height: 1080 });

    expect(software(probe("mp4", interlaced, [aac]), chrome)).toStrictEqual(
      PlaybackPlan.Direct({ audioIndex: 1 }),
    );
    expect(everywhere(probe("mkv", interlaced, [aac]), chrome)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "remux",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Copy({ index: 1 }),
      }),
    );
    expect(everywhere(probe("mkv", interlaced, [eac3]), chrome)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "audio-transcode",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Aac({ index: 2 }),
      }),
    );
  });

  it("deinterlaces an interlaced stream it encodes right after decoding, and a progressive one never", () => {
    const sd = { profile: "Main", width: 720, height: 576 } as const;
    const interlaced = probe("ts", video("mpeg2video", { ...sd, fieldOrder: "tff" }), [aac]);

    const progressive = probe("ts", video("mpeg2video", { ...sd, fieldOrder: "progressive" }), [
      aac,
    ]);

    expect(impls(software(interlaced, chrome))).toStrictEqual([
      "decode.cpu",
      "deinterlace.cpu",
      "scale.cpu",
      "encode.cpu.h264",
    ]);
    expect(impls(everywhere(interlaced, chrome))).toStrictEqual([
      "decode.qsv",
      "deinterlace.qsv",
      "scale.qsv",
      "encode.qsv.h264",
    ]);
    expect(impls(vaapi(interlaced, chrome))).toStrictEqual([
      "decode.vaapi",
      "deinterlace.vaapi",
      "scale.vaapi",
      "encode.vaapi.h264",
    ]);
    expect(impls(software(progressive, chrome))).toStrictEqual([
      "decode.cpu",
      "scale.cpu",
      "encode.cpu.h264",
    ]);
  });

  it("transcodes HDR HEVC on QSV with tone mapping", () => {
    const plan = hardware(probe("mkv", hevcHdr, [aac]), chrome);

    expect(plan).toMatchObject({
      mode: "transcode-qsv",
      video: {
        output: {
          codec: "h264",
          width: 3840,
          height: 2160,
          bitrate: 20_000_000,
          dynamicRange: "sdr",
        },
      },
      audio: AudioPlan.Copy({ index: 1 }),
    });
    expect(impls(plan)).toStrictEqual([
      "decode.qsv",
      "scale.qsv",
      "tonemap.qsv",
      "encode.qsv.h264",
    ]);
  });

  it("refuses software HDR tone mapping", () => {
    expect(software(probe("mkv", hevcHdr, [aac]), chrome)).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "hdr-tone-mapping-requires-hardware" }),
    );
  });

  it("caps software transcodes at 1080p and fits the client's screen", () => {
    const sdr4k = video("mpeg2video", { width: 3840, height: 2160 });

    expect(software(probe("ts", sdr4k, [aac]), chrome)).toMatchObject({
      mode: "transcode-software",
      video: { output: { width: 1920, height: 1080, bitrate: 8_000_000 } },
      audio: AudioPlan.Copy({ index: 1 }),
    });

    const phone = chromeLike({ maxWidth: 1280, maxHeight: 720 });

    expect(software(probe("mp4", h264, [aac]), phone)).toMatchObject({
      mode: "transcode-software",
      video: { output: { width: 1280, height: 720, bitrate: 4_000_000 } },
      audio: AudioPlan.Copy({ index: 1 }),
    });
  });

  it("transcodes 10-bit H.264 that browsers cannot decode", () => {
    const hi10 = video("h264", { profile: "High 10", bitDepth: 10 });

    expect(software(probe("mkv", hi10, [aac]), chrome)).toMatchObject({
      _tag: "Hls",
      mode: "transcode-software",
    });
  });

  it("reports unsupported combinations", () => {
    expect(software(probe("mkv", h264, [aac]), chromeLike({ adaptive: false }))).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "no-adaptive-streaming" }),
    );

    expect(software(probe("mp4", h264, [aac]), chrome, { audioIndex: 9 })).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "audio-track-not-found" }),
    );

    expect(software(probe("mkv", h264, [aac], 0), chrome)).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "unknown-duration" }),
    );

    expect(
      software(
        probe("mkv", video("mpeg4"), [aac]),
        chromeLike({ videoCodecs: [{ codec: "vp9" }] }),
      ),
    ).toStrictEqual(PlaybackPlan.Unsupported({ reason: "no-transcode-target" }));
  });

  it("transcodes on VA-API with tone mapping, and in software with it when ffmpeg can", () => {
    const onVaapi = vaapi(probe("mkv", hevcHdr, [aac]), chrome);

    expect(onVaapi).toMatchObject({
      mode: "transcode-vaapi",
      video: { output: { width: 3840, height: 2160 } },
    });
    expect(impls(onVaapi)).toContain("tonemap.vaapi");

    expect(cpuToneMap(probe("mkv", hevcHdr, [aac]), chrome)).toMatchObject({
      mode: "transcode-software",
      video: { output: { width: 1920, height: 1080 } },
    });
  });

  it("encodes down to the viewer's quality cap, and leaves sources within it alone", () => {
    const capped = software(probe("mp4", h264, [aac]), chrome, { quality: { maxHeight: 720 } });

    expect(capped).toMatchObject({
      mode: "transcode-software",
      video: { output: { width: 1280, height: 720, bitrate: 4_000_000 } },
    });

    const heavy = probe("mkv", h264, [aac], 600, { bitRate: 30_000_000 });

    expect(vaapi(heavy, chrome, { quality: { maxBitrate: 3_000_000 } })).toMatchObject({
      mode: "transcode-vaapi",
      video: { output: { height: 1080, bitrate: 3_000_000 } },
    });

    expect(
      software(probe("mp4", h264, [aac]), chrome, {
        quality: { maxHeight: 1080, maxBitrate: 40_000_000 },
      }),
    ).toStrictEqual(PlaybackPlan.Direct({ audioIndex: 1 }));
  });

  it("drops a quality cap it cannot honour, rather than refusing the title", () => {
    expect(
      software(probe("mp4", hevcHdr, [eac3]), safari, { quality: { maxHeight: 720 } }),
    ).toStrictEqual(PlaybackPlan.Direct({ audioIndex: 2 }));
  });

  it("burns an image subtitle in with an encode, and refuses other tracks", () => {
    const withPgs = probe("mp4", h264, [aac], 600, {
      bitRate: undefined,
      subtitles: [
        {
          index: 4,
          codec: "hdmv_pgs_subtitle",
          kind: "bitmap",
          default: false,
          forced: false,
          hearingImpaired: false,
        },
        {
          index: 5,
          codec: "subrip",
          kind: "text",
          default: false,
          forced: false,
          hearingImpaired: false,
        },
      ],
    });

    const burned = hardware(withPgs, chrome, { burnSubtitle: BurnRequest.Image({ stream: 4 }) });

    expect(burned).toMatchObject({
      mode: "transcode-qsv",
      video: { intent: { burn: { subtitle: { stream: 4, codec: "hdmv_pgs_subtitle" } } } },
    });
    expect(impls(burned)).toStrictEqual([
      "decode.qsv",
      "scale.qsv",
      "burn-image.qsv",
      "encode.qsv.h264",
    ]);

    const withoutGpuOverlay = deciding(
      ["qsv"],
      (key) => key.startsWith("tonemap.cpu") || key.startsWith("burn-image.qsv"),
    );

    expect(
      impls(withoutGpuOverlay(withPgs, chrome, { burnSubtitle: BurnRequest.Image({ stream: 4 }) })),
    ).toStrictEqual([
      "decode.qsv",
      "scale.qsv",
      "move.qsv>cpu",
      "burn-image.cpu",
      "move.cpu>qsv",
      "encode.qsv.h264",
    ]);
    expect(
      software(withPgs, chrome, { burnSubtitle: BurnRequest.Image({ stream: 5 }) }),
    ).toStrictEqual(PlaybackPlan.Unsupported({ reason: "subtitle-not-burnable" }));
    expect(software(withPgs, chrome, { burnSubtitle: BurnRequest.Refused() })).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "subtitle-not-burnable" }),
    );
    expect(software(withPgs, chrome)).toStrictEqual(PlaybackPlan.Direct({ audioIndex: 1 }));
  });

  it("burns a text track in with libass, and refuses it where no row proved libass draws", () => {
    const withText = probe("mp4", h264, [aac], 600, {
      bitRate: undefined,
      subtitles: [
        {
          index: 5,
          codec: "ass",
          kind: "text",
          default: false,
          forced: false,
          hearingImpaired: false,
        },
      ],
    });

    const styled = BurnRequest.Text({ subtitle: { codec: "ass", style: "styled" } });
    const burned = hardware(withText, chrome, { burnSubtitle: styled });

    expect(burned).toMatchObject({
      mode: "transcode-qsv",
      video: {
        intent: {
          burn: {
            _tag: "BurnText",
            subtitle: { codec: "ass", style: "styled", storage: { width: 1920, height: 1080 } },
          },
        },
      },
    });
    expect(impls(burned)).toStrictEqual([
      "decode.qsv",
      "scale.qsv",
      "move.qsv>cpu",
      "burn-text.cpu",
      "move.cpu>qsv",
      "encode.qsv.h264",
    ]);
    // Burning a track in always transcodes, though the client plays the file as it is.
    expect(impls(software(withText, chrome, { burnSubtitle: styled }))).toStrictEqual([
      "decode.cpu",
      "scale.cpu",
      "burn-text.cpu",
      "encode.cpu.h264",
    ]);

    const withoutLibass = deciding(
      [],
      (key) => key.startsWith("tonemap.cpu") || key.startsWith("burn-text."),
    );

    expect(withoutLibass(withText, chrome, { burnSubtitle: styled })).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "subtitle-not-burnable" }),
    );
    expect(withoutLibass(withText, chrome)).toStrictEqual(PlaybackPlan.Direct({ audioIndex: 1 }));
  });

  it("decodes on the CPU and keeps scaling and encoding on the GPU when the device cannot decode", () => {
    const hi10 = probe("mkv", video("h264", { profile: "High 10", bitDepth: 10 }), [aac]);
    const plan = deciding(["qsv"], (key) => key === "decode.qsv:h264/yuv420p10le")(hi10, chrome);

    expect(plan).toMatchObject({ mode: "transcode-qsv" });
    expect(impls(plan)).toStrictEqual([
      "decode.cpu",
      "move.cpu>qsv",
      "scale.qsv",
      "encode.qsv.h264",
    ]);
  });
});

/** The encode a plan runs, its output and the level its stream states. */
const encodeOf = (plan: PlaybackPlan) => {
  const last =
    PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Encode")(plan.video)
      ? plan.video.pipeline.steps.at(-1)
      : undefined;

  return last !== undefined && Op.$is("Encode")(last.op) && PlaybackPlan.$is("Hls")(plan)
    ? {
        output: VideoPlan.$is("Encode")(plan.video) ? plan.video.output : undefined,
        level: last.op.level,
      }
    : undefined;
};

/** An MPEG-2 file of `width` by `height` at `frameRate`, which every client needs encoded. */
const mpeg2At = (width: number, height: number, frameRate: number) =>
  probe("ts", video("mpeg2video", { profile: "Main", width, height, frameRate }), [aac]);

const HEVC_LEVELS = [30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186];

const AV1_LEVELS = [0, 1, 4, 5, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19];

describe("levels", () => {
  it.prop(
    "never plans an HEVC or AV1 encode above the level the client declared, at any size and frame rate",
    {
      codec: Schema.Literals(["hevc", "av1"]),
      pick: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 13 })),
      width: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 7680 })),
      height: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4320 })),
      frameRate: Schema.Literals([12, 23.976, 25, 29.97, 50, 59.94, 60, 100, 120, 144, 240]),
      onGpu: Schema.Boolean,
    },
    ({ codec, pick, width, height, frameRate, onGpu }) => {
      const levels = codec === "hevc" ? HEVC_LEVELS : AV1_LEVELS;
      const declared = levels[pick % levels.length] ?? 0;
      const limits = levelOf(codec, declared);
      const media = mpeg2At(width, height, frameRate);

      const plan = deciding(onGpu ? ["qsv", "vaapi"] : [], () => false)(
        media,
        device([{ codec, maxLevel: declared }]),
      );

      const encode = encodeOf(plan);

      assert.isDefined(limits);

      if (encode?.output === undefined) {
        assert.isTrue(
          limits.maxFrameRate !== undefined && frameRate > limits.maxFrameRate,
          `${codec} ${String(declared)} at ${String(frameRate)} fps: ${JSON.stringify(plan)}`,
        );

        return;
      }

      const { output } = encode;
      const block = codec === "hevc" ? 8 : 1;
      const coded = (side: number) => Math.ceil(side / block) * block;
      const samples = coded(output.width) * coded(output.height);

      assert.strictEqual(output.codec, codec);
      assert.isAtMost(output.width, limits.maxWidth);
      assert.isAtMost(output.height, limits.maxHeight);
      assert.isAtMost(samples, limits.maxPicture);
      assert.isAtMost(samples * frameRate, limits.maxSampleRate);
      assert.isAtMost(output.bitrate, limits.maxBitrate);
      assert.isAtMost(output.bitrate * 2, limits.maxBuffer ?? Number.POSITIVE_INFINITY);
      assert.isDefined(encode.level);
      assert.isAtMost(encode.level, declared);
    },
  );

  it("scales a 1080p60 source down to fit HEVC level 4 and AV1 level 4.0, and states that level", () => {
    const film = mpeg2At(1920, 1080, 60);

    expect(encodeOf(everywhere(film, device([{ codec: "hevc", maxLevel: 120 }])))).toStrictEqual({
      output: { codec: "hevc", width: 1400, height: 788, bitrate: 6_000_000, dynamicRange: "sdr" },
      level: 120,
    });
    expect(encodeOf(everywhere(film, device([{ codec: "av1", maxLevel: 8 }])))).toStrictEqual({
      output: { codec: "av1", width: 1446, height: 814, bitrate: 5_200_000, dynamicRange: "sdr" },
      level: 8,
    });
  });

  it("states the lowest level the plan holds, the buffer included, under the client's", () => {
    const client = device([{ codec: "hevc", maxLevel: 153 }]);

    // 1920x1080 codes as 1920x1088, which level 4 holds, with its 6 Mb/s and 12 Mb buffer.
    expect(encodeOf(everywhere(mpeg2At(1920, 1080, 24), client))).toMatchObject({
      output: { width: 1920, height: 1080, bitrate: 6_000_000 },
      level: 120,
    });
    // Level 2 holds the picture and the bitrate, but not the encoders' 3 Mb buffer.
    expect(encodeOf(everywhere(mpeg2At(320, 180, 24), client))).toMatchObject({
      output: { width: 320, height: 180, bitrate: 1_500_000 },
      level: 63,
    });
  });

  it("holds a small level's bitrate and buffer as well as its picture", () => {
    expect(
      encodeOf(everywhere(mpeg2At(320, 180, 24), device([{ codec: "hevc", maxLevel: 60 }]))),
    ).toMatchObject({ output: { width: 320, height: 180, bitrate: 750_000 }, level: 60 });
    expect(
      encodeOf(everywhere(mpeg2At(640, 360, 24), device([{ codec: "hevc", maxLevel: 30 }]))),
    ).toMatchObject({ output: { width: 198, height: 112, bitrate: 128_000 }, level: 30 });
  });

  it("offers the next target where a level holds the source's frame rate at no size", () => {
    const fast = mpeg2At(1280, 720, 240);

    expect(
      encodeOf(
        everywhere(
          fast,
          device([{ codec: "av1", maxLevel: 4, powerEfficient: true }, { codec: "h264" }]),
        ),
      )?.output,
    ).toMatchObject({ codec: "h264", width: 1280, height: 720 });
    expect(everywhere(fast, device([{ codec: "av1", maxLevel: 4 }]))).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "no-transcode-target" }),
    );
  });

  it.effect("holds a variable-rate source's level at its fastest stretch, not its average", () =>
    Effect.gen(function* () {
      // 640x360 at 60 fps for 4 s, then at 15 fps for 12 s: an average of 26.25 fps.
      const phone = yield* parseFfprobeJson(
        JSON.stringify({
          format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "16.0" },
          streams: [
            {
              index: 0,
              codec_type: "video",
              codec_name: "mpeg2video",
              width: 640,
              height: 360,
              avg_frame_rate: "105/4",
              r_frame_rate: "60/1",
            },
          ],
        }),
        "/library/Phone (2024)/Phone (2024).mp4",
      );

      for (const [codec, declared] of [
        ["hevc", 63],
        ["av1", 1],
      ] as const) {
        const encode = encodeOf(everywhere(phone, device([{ codec, maxLevel: declared }])));
        const limits = levelOf(codec, declared);
        const block = codec === "hevc" ? 8 : 1;
        const coded = (side: number) => Math.ceil(side / block) * block;

        assert.isDefined(encode?.output, codec);
        assert.isDefined(limits, codec);
        assert.isAtMost(
          coded(encode.output.width) * coded(encode.output.height) * 60,
          limits.maxSampleRate,
          `${codec} at 60 fps`,
        );
        assert.isAtMost(encode.level ?? Number.POSITIVE_INFINITY, declared, codec);
      }
    }),
  );

  it("leaves H.264 at the client's size, stating no level, whatever level it declares", () => {
    expect(
      encodeOf(everywhere(mpeg2At(1920, 1080, 60), device([{ codec: "h264", maxLevel: 30 }]))),
    ).toStrictEqual({
      output: { codec: "h264", width: 1920, height: 1080, bitrate: 8_000_000, dynamicRange: "sdr" },
      level: undefined,
    });
  });
});

const Refusals = Schema.Array(Schema.Boolean);

/** A file the replan property plays, and every key its chains could use, made once. */
const replanFixture = (media: MediaProbe) => ({
  media,
  everything: verifiedFor(media, ["qsv", "vaapi"]),
});

const REPLANNED = {
  hdr: replanFixture(probe("mkv", hevcHdr, [aac])),
  sdr: replanFixture(probe("mkv", video("h264", { width: 3840, height: 2160 }), [aac])),
};

describe("replan", () => {
  it.prop(
    "never relaxes the cap, never returns a copy, and names its mode for the encode's domain",
    {
      refused: Refusals,
      capHeight: Schema.Int.check(Schema.isBetween({ minimum: 144, maximum: 2160 })),
      hdr: Schema.Boolean,
    },
    ({ refused, capHeight, hdr }) => {
      const { media, everything } = hdr ? REPLANNED.hdr : REPLANNED.sdr;
      const stream = media.video;

      const intent =
        stream === undefined
          ? undefined
          : encodeIntent(media, stream, chrome, { quality: { maxHeight: capHeight } });

      if (stream === undefined || intent === undefined) return;
      const keys = [...everything.verified];

      const allowed = new Set(
        keys.filter((_, index) => !(refused[index % Math.max(1, refused.length)] ?? false)),
      );

      const replanned = replan(stream, intent, { ...everything, verified: allowed });

      if (Result.isFailure(replanned)) return;
      const { output, pipeline } = replanned.success;

      assert.isTrue(VideoPlan.$is("Encode")(replanned.success));
      assert.isAtMost(output.height, capHeight);
      assert.isAtMost(output.width, intent.bounds.width);

      if (encodeDomain(pipeline) === "cpu") assert.isAtMost(output.height, 1080);
    },
  );

  it("keeps the codec where a verified row remains, and falls to the next target where none does", () => {
    const stream = mpeg2.video;
    const intent = stream === undefined ? undefined : encodeIntent(mpeg2, stream, safari, {});

    assert.isDefined(stream);
    assert.isDefined(intent);
    const everything = verifiedFor(mpeg2, ["qsv", "vaapi"]);

    const codecOf = (excluded: ReadonlyArray<string>) =>
      Result.map(
        replan(stream, intent, {
          ...everything,
          excluded: new Set(excluded.map((impl) => ImplId(impl))),
        }),
        (plan) => `${plan.output.codec} ${encodeDomain(plan.pipeline)}`,
      );

    expect(codecOf([])).toStrictEqual(Result.succeed("hevc qsv"));
    expect(codecOf(["encode.qsv.hevc"])).toStrictEqual(Result.succeed("hevc vaapi"));
    expect(codecOf(["encode.qsv.hevc", "encode.vaapi.hevc"])).toStrictEqual(
      Result.succeed("h264 qsv"),
    );
    expect(
      codecOf(["encode.qsv.hevc", "encode.qsv.h264", "encode.vaapi.hevc", "encode.vaapi.h264"]),
    ).toStrictEqual(Result.succeed("h264 cpu"));
  });
});
