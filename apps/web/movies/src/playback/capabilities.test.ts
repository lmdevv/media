import { Struct } from "effect";
import { describe, expect, it } from "vitest";

import type { MediaSupport } from "./capabilities";
import { detectCapabilities, withoutFailedPath } from "./capabilities";

const browser = (options: {
  readonly types: ReadonlyArray<string>;
  readonly maybe?: ReadonlyArray<string>;
  readonly mse: boolean;
  readonly hdr?: boolean;
}): MediaSupport => ({
  canPlayType: (type) =>
    options.types.includes(type) ? "probably" : (options.maybe ?? []).includes(type) ? "maybe" : "",
  isTypeSupported: options.mse ? (type) => options.types.includes(type) : null,
  hdrDisplay: options.hdr ?? false,
});

const chrome = browser({
  types: [
    'video/mp4; codecs="avc1.640033"',
    'video/mp4; codecs="av01.0.08M.08"',
    'video/mp4; codecs="av01.0.08M.10"',
    'video/mp4; codecs="vp09.00.40.08"',
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/mp4; codecs="opus"',
    'audio/mp4; codecs="flac"',
    "audio/mpeg",
  ],
  maybe: ["video/mp4", "video/webm", "video/x-matroska", "application/vnd.apple.mpegurl"],
  mse: true,
});

const iphone = browser({
  types: [
    'video/mp4; codecs="avc1.640029"',
    'video/mp4; codecs="hvc1.1.6.L153.B0"',
    'video/mp4; codecs="hvc1.2.4.L153.B0"',
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/mp4; codecs="ec-3"',
    'audio/mp4; codecs="ac-3"',
  ],
  maybe: ["video/mp4", "video/quicktime", "application/vnd.apple.mpegurl"],
  mse: false,
  hdr: true,
});

describe("detectCapabilities", () => {
  it("reads Chrome's codecs, plays MP4 and WebM directly, and leaves Matroska to HLS", () => {
    const capabilities = detectCapabilities(chrome);

    expect(capabilities.containers).toStrictEqual(["mp4", "webm"]);
    expect(capabilities.videoCodecs).toStrictEqual([
      { codec: "h264", maxLevel: 51, maxBitDepth: 8 },
      { codec: "av1", maxBitDepth: 10, dynamicRanges: [] },
      { codec: "vp9", maxBitDepth: 8 },
    ]);
    expect(capabilities.audioCodecs.map((support) => support.codec)).toStrictEqual([
      "aac",
      "mp3",
      "opus",
      "flac",
    ]);
    expect(capabilities.mse).toBe(true);
    expect(capabilities.hls).toBe(true);
  });

  it("reads an iPhone's native HLS, HEVC Main 10 with HDR, and Dolby audio", () => {
    const capabilities = detectCapabilities(iphone);

    expect(capabilities.mse).toBe(false);
    expect(capabilities.hls).toBe(true);
    expect(capabilities.containers).toStrictEqual(["mp4", "mov"]);
    expect(capabilities.videoCodecs).toStrictEqual([
      { codec: "h264", maxLevel: 41, maxBitDepth: 8 },
      { codec: "hevc", maxBitDepth: 10, dynamicRanges: ["hdr10", "hlg"] },
    ]);
    expect(capabilities.audioCodecs.map((support) => support.codec)).toStrictEqual([
      "aac",
      "ac3",
      "eac3",
    ]);
  });

  it("offers HDR only on HDR displays", () => {
    const sdr = detectCapabilities({
      canPlayType: iphone.canPlayType,
      isTypeSupported: iphone.isTypeSupported,
      hdrDisplay: false,
    });

    expect(
      sdr.videoCodecs.find((support) => support.codec === "hevc")?.dynamicRanges,
    ).toStrictEqual([]);
  });

  it("plays Matroska directly only when the browser is sure", () => {
    const sure = browser({ types: ["video/x-matroska"], mse: true });

    expect(detectCapabilities(sure).containers).toStrictEqual(["mkv"]);
  });

  it("reports nothing playable for a browser that plays nothing", () => {
    const none = detectCapabilities(browser({ types: [], mse: false }));

    expect(none.containers).toStrictEqual([]);
    expect(none.videoCodecs).toStrictEqual([]);
    expect(none.hls).toBe(false);
    expect(none.mse).toBe(false);
  });
});

const stream = (mode: "direct" | "remux" | "transcode-software", codec: string) => ({
  mode,
  video: { codec, width: 1920, height: 1080, dynamicRange: "sdr" as const },
});

describe("withoutFailedPath", () => {
  const capabilities = detectCapabilities(chrome);

  it("drops progressive playback after a failed direct file", () => {
    expect(withoutFailedPath(capabilities, stream("direct", "h264"))?.containers).toStrictEqual([]);
  });

  it("drops the copied codec after a failed remux, so the server transcodes", () => {
    const next = withoutFailedPath(capabilities, stream("remux", "av1"));

    expect(next?.videoCodecs.map((support) => support.codec)).toStrictEqual(["h264", "vp9"]);
  });

  it("has nothing left to drop after H.264 or a transcode failed", () => {
    expect(withoutFailedPath(capabilities, stream("remux", "h264"))).toBeNull();
    expect(withoutFailedPath(capabilities, stream("transcode-software", "h264"))).toBeNull();
    expect(
      withoutFailedPath(
        Struct.evolve(capabilities, { containers: () => [] }),
        stream("direct", "h264"),
      ),
    ).toBeNull();
  });
});
