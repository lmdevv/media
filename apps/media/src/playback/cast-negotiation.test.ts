import { describe, expect, it } from "@effect/vitest";
import { castCapabilities } from "@media/contracts/cast";

import type { AudioTrack, MediaProbe, VideoStream } from "../media/media-probe.ts";
import { decidePlayback, PlaybackPlan } from "./playback-decision.ts";

const video = (codec: string, options: Partial<VideoStream> = {}): VideoStream => ({
  index: 0,
  codec,
  profile: "High",
  level: 41,
  bitDepth: 8,
  width: 1920,
  height: 1080,
  dynamicRange: "sdr",
  ...options,
});

const audio = (codec: string, channels: number): AudioTrack => ({
  index: 1,
  codec,
  channels,
  default: true,
});

const probe = (
  container: MediaProbe["container"],
  stream: VideoStream,
  track: AudioTrack,
): MediaProbe => ({
  container,
  formatName: container,
  durationSeconds: 5_400,
  startSeconds: 0,
  video: stream,
  audio: [track],
  subtitles: [],
  chapters: [],
});

const hevcHdr = video("hevc", {
  profile: "Main 10",
  level: 153,
  bitDepth: 10,
  width: 3840,
  height: 2160,
  dynamicRange: "hdr10",
});

const options = { audioIndex: undefined, hardware: undefined, softwareToneMapping: false };

const rung = (file: MediaProbe, modelName: string | undefined): string => {
  return PlaybackPlan.$match(decidePlayback(file, castCapabilities(modelName), options), {
    Direct: () => "direct",
    Hls: ({ mode }) => mode,
    Unsupported: ({ reason }) => `unsupported: ${reason}`,
  });
};

describe("negotiating for a Chromecast", () => {
  it("plays H.264 and AAC on every model, remuxing what is not MP4", () => {
    expect(rung(probe("mp4", video("h264"), audio("aac", 2)), undefined)).toBe("direct");
    expect(rung(probe("mkv", video("h264"), audio("aac", 6)), "Chromecast")).toBe("remux");
    expect(rung(probe("mkv", video("h264"), audio("ac3", 6)), "Chromecast")).toBe(
      "audio-transcode",
    );
  });

  it("offers HEVC, 4K, and HDR only to models that play them", () => {
    expect(rung(probe("mkv", hevcHdr, audio("aac", 2)), "Chromecast Ultra")).toBe("remux");
    expect(rung(probe("mkv", hevcHdr, audio("aac", 2)), "Chromecast with Google TV")).toBe("remux");
    expect(
      rung(
        probe("mkv", video("hevc", { profile: "Main", level: 120 }), audio("aac", 2)),
        "Chromecast",
      ),
    ).toBe("transcode-software");
    expect(rung(probe("mkv", hevcHdr, audio("aac", 2)), "Chromecast")).toBe(
      "unsupported: hdr-tone-mapping-requires-hardware",
    );
  });
});
