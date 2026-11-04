import { describe, expect, it } from "@effect/vitest";
import type { ClientCapabilities } from "@media/contracts/media-playback";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import { AudioPlan, decidePlayback, PlaybackPlan, VideoPlan } from "./playback-decision.ts";

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

const software = { audioIndex: undefined, hardware: undefined, softwareToneMapping: false };

const hardware = { audioIndex: undefined, hardware: "qsv", softwareToneMapping: false } as const;

const vaapi = { audioIndex: undefined, hardware: "vaapi", softwareToneMapping: false } as const;

describe("decidePlayback", () => {
  it("plays compatible files directly", () => {
    expect(decidePlayback(probe("mp4", h264, [aac]), chrome, software)).toStrictEqual(
      PlaybackPlan.Direct({ audioIndex: 1 }),
    );
    expect(decidePlayback(probe("mp4", hevcHdr, [eac3]), safari, software)).toStrictEqual(
      PlaybackPlan.Direct({ audioIndex: 2 }),
    );
  });

  it("remuxes when only the container is unsupported", () => {
    expect(decidePlayback(probe("mkv", h264, [aac]), chrome, software)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "remux",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Copy({ index: 1 }),
      }),
    );
  });

  it("remuxes to play a non-default audio track", () => {
    const twoTracks = probe("mp4", h264, [aac, audio(3, "aac", 2, false)]);

    expect(decidePlayback(twoTracks, chrome, { ...software, audioIndex: 3 })).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "remux",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Copy({ index: 3 }),
      }),
    );
  });

  it("transcodes only the audio when the client lacks its codec", () => {
    expect(decidePlayback(probe("mkv", h264, [eac3]), chrome, software)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "audio-transcode",
        video: VideoPlan.Copy(),
        audio: AudioPlan.Aac({ index: 2 }),
      }),
    );
  });

  it("transcodes HDR HEVC on QSV with tone mapping", () => {
    expect(decidePlayback(probe("mkv", hevcHdr, [aac]), chrome, hardware)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "transcode-qsv",
        video: VideoPlan.Encode({
          encoder: "qsv",
          width: 3840,
          height: 2160,
          toneMap: true,
          bitrate: 20_000_000,
          burnSubtitle: undefined,
        }),
        audio: AudioPlan.Copy({ index: 1 }),
      }),
    );
  });

  it("refuses software HDR tone mapping", () => {
    expect(decidePlayback(probe("mkv", hevcHdr, [aac]), chrome, software)).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "hdr-tone-mapping-requires-hardware" }),
    );
  });

  it("caps software transcodes at 1080p and fits the client's screen", () => {
    const sdr4k = video("mpeg2video", { width: 3840, height: 2160 });

    expect(decidePlayback(probe("ts", sdr4k, [aac]), chrome, software)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "transcode-software",
        video: VideoPlan.Encode({
          encoder: "software",
          width: 1920,
          height: 1080,
          toneMap: false,
          bitrate: 8_000_000,
          burnSubtitle: undefined,
        }),
        audio: AudioPlan.Copy({ index: 1 }),
      }),
    );

    const phone = chromeLike({ maxWidth: 1280, maxHeight: 720 });

    expect(decidePlayback(probe("mp4", h264, [aac]), phone, software)).toStrictEqual(
      PlaybackPlan.Hls({
        mode: "transcode-software",
        video: VideoPlan.Encode({
          encoder: "software",
          width: 1280,
          height: 720,
          toneMap: false,
          bitrate: 4_000_000,
          burnSubtitle: undefined,
        }),
        audio: AudioPlan.Copy({ index: 1 }),
      }),
    );
  });

  it("transcodes 10-bit H.264 that browsers cannot decode", () => {
    const hi10 = video("h264", { profile: "High 10", bitDepth: 10 });

    expect(decidePlayback(probe("mkv", hi10, [aac]), chrome, software)).toMatchObject({
      _tag: "Hls",
      mode: "transcode-software",
    });
  });

  it("reports unsupported combinations", () => {
    expect(
      decidePlayback(probe("mkv", h264, [aac]), chromeLike({ adaptive: false }), software),
    ).toStrictEqual(PlaybackPlan.Unsupported({ reason: "no-adaptive-streaming" }));

    expect(
      decidePlayback(probe("mp4", h264, [aac]), chrome, { ...software, audioIndex: 9 }),
    ).toStrictEqual(PlaybackPlan.Unsupported({ reason: "audio-track-not-found" }));

    expect(decidePlayback(probe("mkv", h264, [aac], 0), chrome, software)).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "unknown-duration" }),
    );

    expect(
      decidePlayback(
        probe("mkv", video("mpeg4"), [aac]),
        chromeLike({ videoCodecs: [{ codec: "vp9" }] }),
        software,
      ),
    ).toStrictEqual(PlaybackPlan.Unsupported({ reason: "no-transcode-target" }));
  });

  it("transcodes on VA-API with tone mapping, and in software with it when ffmpeg can", () => {
    expect(decidePlayback(probe("mkv", hevcHdr, [aac]), chrome, vaapi)).toMatchObject({
      mode: "transcode-vaapi",
      video: { encoder: "vaapi", width: 3840, height: 2160, toneMap: true },
    });

    expect(
      decidePlayback(probe("mkv", hevcHdr, [aac]), chrome, {
        ...software,
        softwareToneMapping: true,
      }),
    ).toMatchObject({
      mode: "transcode-software",
      video: { encoder: "software", width: 1920, height: 1080, toneMap: true },
    });
  });

  it("encodes down to the viewer's quality cap, and leaves sources within it alone", () => {
    const capped = decidePlayback(probe("mp4", h264, [aac]), chrome, {
      ...software,
      quality: { maxHeight: 720 },
    });

    expect(capped).toMatchObject({
      mode: "transcode-software",
      video: { width: 1280, height: 720, bitrate: 4_000_000 },
    });

    const heavy = probe("mkv", h264, [aac], 600, { bitRate: 30_000_000 });

    expect(
      decidePlayback(heavy, chrome, { ...vaapi, quality: { maxBitrate: 3_000_000 } }),
    ).toMatchObject({ mode: "transcode-vaapi", video: { height: 1080, bitrate: 3_000_000 } });

    expect(
      decidePlayback(probe("mp4", h264, [aac]), chrome, {
        ...software,
        quality: { maxHeight: 1080, maxBitrate: 40_000_000 },
      }),
    ).toStrictEqual(PlaybackPlan.Direct({ audioIndex: 1 }));
  });

  it("drops a quality cap it cannot honour, rather than refusing the title", () => {
    expect(
      decidePlayback(probe("mp4", hevcHdr, [eac3]), safari, {
        ...software,
        quality: { maxHeight: 720 },
      }),
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

    expect(decidePlayback(withPgs, chrome, { ...hardware, burnSubtitle: 4 })).toMatchObject({
      mode: "transcode-qsv",
      video: { encoder: "qsv", burnSubtitle: 4 },
    });
    expect(decidePlayback(withPgs, chrome, { ...software, burnSubtitle: 5 })).toStrictEqual(
      PlaybackPlan.Unsupported({ reason: "subtitle-not-burnable" }),
    );
    expect(decidePlayback(withPgs, chrome, software)).toStrictEqual(
      PlaybackPlan.Direct({ audioIndex: 1 }),
    );
  });
});
