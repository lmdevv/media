import { assert, describe, expect, it } from "@effect/vitest";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import { Result, Schema } from "effect";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import { verifiedFor, withoutToneMaps } from "../testing/capability-snapshots.ts";
import {
  AudioPlan,
  decidePlayback,
  type DecisionOptions,
  encodeIntent,
  PlaybackPlan,
  replan,
  VideoPlan,
} from "./playback-decision.ts";
import { encodeDomain } from "./video-pipeline.ts";
import type { CapabilityKey, GpuDomain } from "./video-ops.ts";

interface VideoOptions {
  readonly profile?: string;
  readonly bitDepth?: number;
  readonly width?: number;
  readonly height?: number;
  readonly dynamicRange?: VideoStream["dynamicRange"];
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

/** The CPU alone, with software tone mapping. */
const softwareToneMapping = deciding([], () => false);

/** Quick Sync and the CPU, tone mapping only on the GPU. */
const hardware = deciding(["qsv"], (key) => key.startsWith("tonemap.cpu"));

/** VA-API and the CPU, tone mapping only on the GPU. */
const vaapi = deciding(["vaapi"], (key) => key.startsWith("tonemap.cpu"));

const impls = (plan: PlaybackPlan): ReadonlyArray<string> =>
  PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Encode")(plan.video)
    ? plan.video.pipeline.steps.map((step) => step.impl)
    : [];

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
    expect(impls(plan)).toStrictEqual(["decode.qsv", "scale.qsv", "tonemap.qsv", "encode.qsv"]);
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

    expect(softwareToneMapping(probe("mkv", hevcHdr, [aac]), chrome)).toMatchObject({
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

    const burned = hardware(withPgs, chrome, { burnSubtitle: 4 });

    expect(burned).toMatchObject({
      mode: "transcode-qsv",
      video: { intent: { burnImage: { stream: 4, codec: "hdmv_pgs_subtitle" } } },
    });
    expect(impls(burned)).toStrictEqual([
      "decode.qsv",
      "scale.qsv",
      "move.qsv>cpu",
      "burn-image.cpu",
      "move.cpu>qsv",
      "encode.qsv",
    ]);
    expect(software(withPgs, chrome, { burnSubtitle: 5 })).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "subtitle-not-burnable" }),
    );
    expect(software(withPgs, chrome)).toStrictEqual(PlaybackPlan.Direct({ audioIndex: 1 }));
  });

  it("decodes on the CPU and keeps scaling and encoding on the GPU when the device cannot decode", () => {
    const hi10 = probe("mkv", video("h264", { profile: "High 10", bitDepth: 10 }), [aac]);
    const plan = deciding(["qsv"], (key) => key === "decode.qsv:h264/yuv420p10le")(hi10, chrome);

    expect(plan).toMatchObject({ mode: "transcode-qsv" });
    expect(impls(plan)).toStrictEqual(["decode.cpu", "move.cpu>qsv", "scale.qsv", "encode.qsv"]);
  });
});

const Refusals = Schema.Array(Schema.Boolean);

describe("replan", () => {
  it.prop(
    "never relaxes the cap, never returns a copy, and names its mode for the encode's domain",
    {
      refused: Refusals,
      capHeight: Schema.Int.check(Schema.isBetween({ minimum: 144, maximum: 2160 })),
      hdr: Schema.Boolean,
    },
    ({ refused, capHeight, hdr }) => {
      const media = probe("mkv", hdr ? hevcHdr : video("h264", { width: 3840, height: 2160 }), [
        aac,
      ]);

      const stream = media.video;

      const intent =
        stream === undefined
          ? undefined
          : encodeIntent(media, stream, chrome, { quality: { maxHeight: capHeight } });

      if (stream === undefined || intent === undefined) return;
      const everything = verifiedFor(media, ["qsv", "vaapi"]);
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
});
