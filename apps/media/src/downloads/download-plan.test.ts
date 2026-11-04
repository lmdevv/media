import { describe, expect, it } from "@effect/vitest";
import type { ClientCapabilities } from "@media/contracts/media-playback";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import { AudioPlan, VideoPlan } from "../playback/playback-decision.ts";
import { decideDownload, DownloadPlan } from "./download-plan.ts";
import { progressSeconds } from "./downloads.ts";

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

const options = { audioIndex: undefined, softwareToneMapping: true, sizeBytes: 900_000_000 };

const aac = audio(1, "aac", true);

describe("decideDownload", () => {
  it("keeps an MP4 the device plays within the quality as it is", () => {
    expect(
      decideDownload(
        probe("mp4", video("h264", 720), [aac], 2_000_000),
        iphone,
        "standard",
        options,
      ),
    ).toStrictEqual(DownloadPlan.Original());
  });

  it("writes an MP4 from another container, or for another audio track, copying what it can", () => {
    const mkv = probe("mkv", video("h264", 720), [aac, audio(2, "dts", false)], 2_000_000);
    const remux = decideDownload(mkv, iphone, "standard", options);

    expect(remux).toMatchObject({ _tag: "Mp4", mode: "remux", video: VideoPlan.Copy() });
    expect(remux).toMatchObject({ audio: AudioPlan.Copy({ index: 1 }) });

    expect(
      decideDownload(
        probe("mp4", video("h264", 720), [aac, audio(2, "dts", false)]),
        iphone,
        "standard",
        {
          ...options,
          audioIndex: 2,
        },
      ),
    ).toMatchObject({ _tag: "Mp4", mode: "audio-transcode", audio: AudioPlan.Aac({ index: 2 }) });
  });

  it("encodes a source above the quality down to it, bounding the size by the bitrate", () => {
    const film = probe("mkv", video("h264", 1080), [aac], 12_000_000);
    const standard = decideDownload(film, iphone, "standard", options);

    expect(standard).toMatchObject({
      _tag: "Mp4",
      mode: "transcode-software",
      video: { _tag: "Encode", encoder: "software", height: 720, bitrate: 4_000_000 },
    });
    expect(standard).toMatchObject({ estimatedBytes: Math.ceil((5_600_000 * 3000) / 8) });
    expect(decideDownload(film, iphone, "high", options)).toMatchObject({
      _tag: "Mp4",
      video: { _tag: "Encode", height: 1080, bitrate: 8_000_000 },
    });
  });

  it("refuses a source it cannot bring within the quality, rather than the whole original", () => {
    const hdr = probe("mp4", video("hevc", 2160, "hdr10"), [aac], 30_000_000);

    expect(
      decideDownload(hdr, iphone, "standard", { ...options, softwareToneMapping: false }),
    ).toStrictEqual(DownloadPlan.Unsupported({ reason: "hdr-tone-mapping-requires-hardware" }));
  });

  it("bounds the size of an encode with copied audio by a generous audio rate", () => {
    const film = probe("mkv", video("h264", 1080), [audio(1, "eac3", true)], 12_000_000);

    expect(decideDownload(film, iphone, "standard", options)).toMatchObject({
      audio: AudioPlan.Copy({ index: 1 }),
      estimatedBytes: Math.ceil(((4_000_000 + 1_600_000) * 3000) / 8),
    });
  });

  it("refuses a file without video", () => {
    expect(decideDownload(probe("mp4", undefined, [aac]), iphone, "high", options)).toStrictEqual(
      DownloadPlan.Unsupported({ reason: "no-video-stream" }),
    );
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
