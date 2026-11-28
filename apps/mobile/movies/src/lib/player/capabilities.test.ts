import { playsDirectly } from "@media/contracts/direct-play";
import type { DirectPlayFile } from "@media/contracts/direct-play";
import { ClientCapabilities } from "@media/contracts/media-playback";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { capabilitiesOn, IOS_CAPABILITIES } from "./capabilities";

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

/**
 * A 4K HEVC Main 10 MP4 in `dynamicRange`, stating PQ, with Dolby Vision's configuration and an RPU
 * on its first picture when given.
 */
const uhd = (
  dynamicRange: "hdr10" | "hlg" | "dolby-vision",
  dolbyVision?: { readonly profile: number; readonly compatibility: number },
) => ({
  container: "mp4",
  video: {
    codec: "hevc",
    profile: "Main 10",
    bitDepth: 10,
    width: 3840,
    height: 2160,
    dynamicRange,
    dolbyVision,
    dolbyVisionRpu: dolbyVision === undefined ? undefined : (true as const),
    colour: { transfer: dynamicRange === "hlg" ? "arib-std-b67" : "smpte2084" },
  },
  audio: { codec: "eac3", channels: 6 },
});

describe("capabilitiesOn", () => {
  it("lists HDR10 and HLG on a screen that shows HDR, and no screen format on an SDR one", () => {
    const onHdr = capabilitiesOn(true);

    expect(Schema.decodeSync(ClientCapabilities)(onHdr)).toStrictEqual(onHdr);
    expect(onHdr.hdrScreen).toStrictEqual(["hdr10", "hlg"]);
    expect(onHdr.videoCodecs).toStrictEqual(IOS_CAPABILITIES.videoCodecs);
    expect(capabilitiesOn(false)).toStrictEqual(IOS_CAPABILITIES);
    expect(capabilitiesOn(false)).not.toHaveProperty("hdrScreen");
  });
});

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
    expect(playsDirectly(IOS_CAPABILITIES, uhd("hdr10"))).toBe(true);
    expect(playsDirectly(IOS_CAPABILITIES, uhd("hlg"))).toBe(true);
    expect(
      playsDirectly(IOS_CAPABILITIES, uhd("dolby-vision", { profile: 8, compatibility: 1 })),
    ).toBe(true);
    // Dolby Vision whose configuration was not read says nothing a player can rely on.
    expect(playsDirectly(IOS_CAPABILITIES, uhd("dolby-vision"))).toBe(false);
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
