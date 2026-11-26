import { describe, expect, it } from "@effect/vitest";
import type { ClientCapabilities } from "@media/contracts/media-playback";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import { AudioPlan, VideoPlan } from "../playback/playback-decision.ts";
import { decideDownload, DownloadPlan } from "./download-plan.ts";
import { progressSeconds } from "./downloads.ts";
import { verifiedFor, withoutToneMaps } from "../testing/capability-snapshots.ts";
import type { CapabilityKey } from "../playback/video-ops.ts";

const video = (
  codec: string,
  height: number,
  dynamicRange: VideoStream["dynamicRange"] = "sdr",
) => ({
  index: 0,
  codec,
  profile: codec === "hevc" ? "Main 10" : "High",
  level: 41,
  bitDepth: codec === "hevc" ? 10 : 8,
  width: Math.round((height * 16) / 9),
  height,
  dynamicRange,
});

const audio = (index: number, codec: string, isDefault: boolean): AudioTrack => ({
  index,
  codec,
  channels: 6,
  default: isDefault,
});

const probe = (
  container: MediaProbe["container"],
  stream: VideoStream | undefined,
  tracks: ReadonlyArray<AudioTrack>,
  bitRate?: number,
): MediaProbe => ({
  container,
  formatName: container,
  durationSeconds: 3000,
  startSeconds: 0,
  bitRate,
  video: stream,
  audio: tracks,
  subtitles: [],
  chapters: [],
});

const iphone: ClientCapabilities = {
  containers: ["mp4", "mov"],
  videoCodecs: [
    { codec: "h264", maxLevel: 52, maxBitDepth: 8 },
    { codec: "hevc", profiles: ["Main", "Main 10"], maxBitDepth: 10, dynamicRanges: ["hdr10"] },
  ],
  audioCodecs: [{ codec: "aac" }, { codec: "eac3" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

/** A browser that plays H.264 alone. */
const h264Browser: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

/** A device that plays HEVC Main alone. */
const hevcOnly: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "hevc", profiles: ["Main"] }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

/** A device that plays AV1 alone. */
const av1Only: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "av1" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

/**
 * A server whose Quick Sync device and CPU do everything, software tone mapping included, except
 * the keys `refused` picks; `domains` drops the device.
 */
const optionsFor = (
  media: MediaProbe,
  refused: (key: CapabilityKey) => boolean = () => false,
  domains: ReadonlyArray<"qsv"> = ["qsv"],
) => ({
  audioIndex: undefined,
  capabilities: verifiedFor(media, domains, refused),
  sizeBytes: 900_000_000,
});

/** The capability key of each stage an encode plan runs. */
const stagesOf = (plan: DownloadPlan): ReadonlyArray<string> =>
  DownloadPlan.$is("Mp4")(plan) && VideoPlan.$is("Encode")(plan.video)
    ? plan.video.pipeline.steps.map((step) => step.capability)
    : [];

const aac = audio(1, "aac", true);

describe("decideDownload", () => {
  it("keeps an MP4 the device plays within the quality as it is", () => {
    expect(
      decideDownload(
        probe("mp4", video("h264", 720), [aac], 2_000_000),
        iphone,
        "standard",
        optionsFor(probe("mp4", video("h264", 720), [aac], 2_000_000)),
      ),
    ).toStrictEqual(DownloadPlan.Original());
  });

  it("writes an MP4 from another container, or for another audio track, copying what it can", () => {
    const mkv = probe("mkv", video("h264", 720), [aac, audio(2, "dts", false)], 2_000_000);
    const remux = decideDownload(mkv, iphone, "standard", optionsFor(mkv));

    expect(remux).toMatchObject({ _tag: "Mp4", mode: "remux", video: VideoPlan.Copy() });
    expect(remux).toMatchObject({ audio: AudioPlan.Copy({ index: 1 }) });

    expect(
      decideDownload(
        probe("mp4", video("h264", 720), [aac, audio(2, "dts", false)]),
        iphone,
        "standard",
        {
          ...optionsFor(probe("mp4", video("h264", 720), [aac, audio(2, "dts", false)])),
          audioIndex: 2,
        },
      ),
    ).toMatchObject({ _tag: "Mp4", mode: "audio-transcode", audio: AudioPlan.Aac({ index: 2 }) });
  });

  it("encodes a source above the quality down to it on the CPU, as H.264 for a device that plays it, even where a GPU does everything", () => {
    const film = probe("mkv", video("h264", 1080), [aac], 12_000_000);

    for (const client of [iphone, h264Browser]) {
      const standard = decideDownload(film, client, "standard", optionsFor(film));

      expect(standard).toMatchObject({
        _tag: "Mp4",
        mode: "transcode-software",
        video: {
          _tag: "Encode",
          output: { codec: "h264", width: 1280, height: 720, bitrate: 4_000_000 },
        },
        estimatedBytes: Math.ceil((5_600_000 * 3000) / 8),
      });
      expect(stagesOf(standard)).toStrictEqual([
        "decode.cpu:h264/yuv420p",
        "scale.cpu:8>8",
        "encode.cpu:h264/8/crf",
      ]);
      expect(decideDownload(film, client, "high", optionsFor(film))).toMatchObject({
        _tag: "Mp4",
        mode: "transcode-software",
        video: { _tag: "Encode", output: { codec: "h264", height: 1080, bitrate: 8_000_000 } },
      });
      expect(
        decideDownload(
          film,
          client,
          "standard",
          optionsFor(film, () => false, []),
        ),
      ).toEqual(standard);
    }
  });

  it("encodes HEVC or AV1 on the CPU for a device that plays no H.264", () => {
    const film = probe("mkv", video("h264", 1080), [aac], 12_000_000);
    const hevc = decideDownload(film, hevcOnly, "standard", optionsFor(film));

    expect(hevc).toMatchObject({
      mode: "transcode-software",
      video: { _tag: "Encode", output: { codec: "hevc", height: 720, bitrate: 3_000_000 } },
    });
    expect(stagesOf(hevc).at(-1)).toBe("encode.cpu:hevc/8/crf");
    expect(decideDownload(film, av1Only, "standard", optionsFor(film))).toMatchObject({
      mode: "transcode-software",
      video: { _tag: "Encode", output: { codec: "av1", height: 720, bitrate: 2_600_000 } },
    });
  });

  it("never plans an encode above the quality's height or bitrate", () => {
    const caps = { standard: [720, 4_000_000], high: [1080, 10_000_000] } as const;

    for (const source of [video("h264", 2160), video("mpeg2video", 1080), video("hevc", 2160)]) {
      const film = probe("mkv", source, [aac], 60_000_000);

      for (const client of [iphone, h264Browser, hevcOnly, av1Only]) {
        for (const options of [optionsFor(film), optionsFor(film, () => false, [])]) {
          for (const quality of ["standard", "high"] as const) {
            const plan = decideDownload(film, client, quality, options);
            const [height, bitrate] = caps[quality];

            if (DownloadPlan.$is("Mp4")(plan) && VideoPlan.$is("Encode")(plan.video)) {
              expect(plan.video.output.height).toBeLessThanOrEqual(height);
              expect(plan.video.output.bitrate).toBeLessThanOrEqual(bitrate);
            } else {
              expect(plan).toStrictEqual(DownloadPlan.Original());
            }
          }
        }
      }
    }
  });

  it("refuses a source it cannot bring within the quality, rather than the whole original", () => {
    const hdr = probe("mp4", video("hevc", 2160, "hdr10"), [aac], 30_000_000);

    expect(decideDownload(hdr, iphone, "standard", optionsFor(hdr, withoutToneMaps))).toStrictEqual(
      DownloadPlan.Unsupported({ reason: "hdr-tone-mapping-requires-hardware" }),
    );
  });

  it("bounds the size of an encode with copied audio by a generous audio rate", () => {
    const film = probe("mkv", video("h264", 1080), [audio(1, "eac3", true)], 12_000_000);

    expect(decideDownload(film, iphone, "standard", optionsFor(film))).toMatchObject({
      audio: AudioPlan.Copy({ index: 1 }),
      estimatedBytes: Math.ceil(((4_000_000 + 1_600_000) * 3000) / 8),
    });
  });

  it("refuses a file without video", () => {
    expect(
      decideDownload(
        probe("mp4", undefined, [aac]),
        iphone,
        "high",
        optionsFor(probe("mp4", undefined, [aac])),
      ),
    ).toStrictEqual(DownloadPlan.Unsupported({ reason: "no-video-stream" }));
  });
});

describe("progressSeconds", () => {
  it("reads the last position ffmpeg reported", () => {
    expect(
      progressSeconds("frame=1\nout_time_us=1500000\nprogress=continue\nout_time_us=2250000\n"),
    ).toBe(2.25);
    expect(progressSeconds("frame=1\nprogress=continue\n")).toBeUndefined();
  });
});
