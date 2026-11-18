import { playsDirectly } from "@media/contracts/direct-play";
import type { DirectPlayFile } from "@media/contracts/direct-play";
import { ClientCapabilities } from "@media/contracts/media-playback";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { IOS_CAPABILITIES } from "./capabilities";

const video = {
  codec: "h264",
  profile: "High",
  level: 41,
  bitDepth: 8,
  width: 1920,
  height: 1080,
  dynamicRange: "sdr",
} as const;

const h264Mp4: DirectPlayFile = {
  container: "mp4",
  video,
  audio: { codec: "aac", channels: 2 },
};

describe("IOS_CAPABILITIES", () => {
  it("is what the negotiation schema accepts", () => {
    expect(Schema.decodeSync(ClientCapabilities)(IOS_CAPABILITIES)).toStrictEqual(IOS_CAPABILITIES);
  });

  it("plays H.264 MP4 and QuickTime files directly", () => {
    expect(playsDirectly(IOS_CAPABILITIES, h264Mp4)).toBe(true);
    expect(playsDirectly(IOS_CAPABILITIES, { ...h264Mp4, container: "mov" })).toBe(true);
  });

  it("sends Matroska, WebM, and AVI through HLS", () => {
    for (const container of ["mkv", "webm", "avi"]) {
      expect(playsDirectly(IOS_CAPABILITIES, { ...h264Mp4, container })).toBe(false);
    }
  });

  it("plays HEVC Main 10 in HDR10, HLG, and Dolby Vision up to 4K", () => {
    for (const dynamicRange of ["hdr10", "hlg", "dolby-vision"] as const) {
      expect(
        playsDirectly(IOS_CAPABILITIES, {
          container: "mp4",
          video: {
            codec: "hevc",
            profile: "Main 10",
            bitDepth: 10,
            width: 3840,
            height: 2160,
            dynamicRange,
          },
          audio: { codec: "eac3", channels: 6 },
        }),
      ).toBe(true);
    }
  });

  it("transcodes what AVPlayer cannot decode", () => {
    expect(playsDirectly(IOS_CAPABILITIES, { ...h264Mp4, video: { ...video, bitDepth: 10 } })).toBe(
      false,
    );
    expect(playsDirectly(IOS_CAPABILITIES, { ...h264Mp4, video: { ...video, level: 62 } })).toBe(
      false,
    );
    expect(playsDirectly(IOS_CAPABILITIES, { ...h264Mp4, video: { ...video, codec: "vp9" } })).toBe(
      false,
    );
    expect(
      playsDirectly(IOS_CAPABILITIES, { ...h264Mp4, audio: { codec: "dts", channels: 6 } }),
    ).toBe(false);
    expect(
      playsDirectly(IOS_CAPABILITIES, { ...h264Mp4, audio: { codec: "vorbis", channels: 2 } }),
    ).toBe(false);
  });
});
