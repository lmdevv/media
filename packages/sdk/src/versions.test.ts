import type { ClientCapabilities } from "@media/contracts/media-playback";
import { MediaVersion } from "@media/contracts/models/catalog";
import { Option, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { detail, label, playsDirectly, preferredVersion } from "./versions";

const decodeVersion = Schema.decodeSync(MediaVersion);

const CHROMIUM: ClientCapabilities = {
  containers: ["mp4", "webm"],
  videoCodecs: [
    { codec: "h264", maxLevel: 51, maxBitDepth: 8 },
    { codec: "vp9", maxBitDepth: 10, dynamicRanges: [] },
  ],
  audioCodecs: [
    { codec: "aac", maxChannels: 8 },
    { codec: "opus", maxChannels: 8 },
  ],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

type VersionFields = Partial<(typeof MediaVersion)["Encoded"]>;

const MAIN_AND_HIGH_ONLY: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", profiles: ["High", "Main"] }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

const version = (overrides: VersionFields = {}): MediaVersion =>
  decodeVersion({
    id: "file-1",
    versionName: null,
    width: 1920,
    height: 1080,
    hdr: "none",
    videoCodec: "h264",
    videoProfile: null,
    videoLevel: null,
    videoBitDepth: 8,
    audioCodec: "aac",
    audioChannels: 2,
    audioTracks: 1,
    container: "mp4",
    sizeBytes: 1_000_000,
    durationMs: 600_000,
    lastPlayed: false,
    ...overrides,
  });

const featureTest = (lastPlayed: string | null = null): ReadonlyArray<MediaVersion> =>
  (
    [
      {
        id: "hdr",
        versionName: "HDR10 HEVC",
        width: 3840,
        height: 2160,
        hdr: "hdr10",
        videoCodec: "hevc",
        videoBitDepth: 10,
        audioCodec: "eac3",
        audioChannels: 6,
        container: "mkv",
      },
      { id: "direct", versionName: "Direct Play" },
      { id: "multi", versionName: "Multi-Audio and Subtitles", container: "mkv" },
      {
        id: "sd",
        versionName: "SD Interlaced MPEG-2",
        width: 720,
        height: 576,
        videoCodec: "mpeg2video",
        audioCodec: "ac3",
        container: "mkv",
      },
    ] satisfies ReadonlyArray<VersionFields>
  ).map((fields) => version({ ...fields, lastPlayed: fields.id === lastPlayed }));

const versions = fc
  .array(
    fc.record({
      container: fc.constantFrom("mp4", "mkv", "webm", "avi"),
      videoCodec: fc.constantFrom("h264", "hevc", "vp9", "mpeg2video"),
      audioCodec: fc.constantFrom("aac", "ac3", "opus", "dts"),
      hdr: fc.constantFrom("none" as const, "hdr10" as const, "dolby_vision" as const),
      lastPlayed: fc.boolean(),
    }),
    { maxLength: 6 },
  )
  .map((records) =>
    records.map((record, index) => version({ ...record, id: `file-${String(index)}` })),
  );

describe("versions", () => {
  it("plays a file directly only when its container, video, and audio all suit the client", () => {
    expect(playsDirectly(version(), CHROMIUM)).toBe(true);
    expect(playsDirectly(version({ container: "mkv" }), CHROMIUM)).toBe(false);
    expect(playsDirectly(version({ videoCodec: "hevc" }), CHROMIUM)).toBe(false);
    expect(playsDirectly(version({ audioCodec: "ac3" }), CHROMIUM)).toBe(false);
    expect(playsDirectly(version({ videoBitDepth: 10 }), CHROMIUM)).toBe(false);
    expect(playsDirectly(version({ container: "webm", videoCodec: "vp9" }), CHROMIUM)).toBe(true);
    expect(
      playsDirectly(
        version({ container: "webm", videoCodec: "vp9", videoBitDepth: 10, hdr: "hdr10" }),
        CHROMIUM,
      ),
    ).toBe(false);
    expect(playsDirectly(version({ width: 7680, height: 4320 }), CHROMIUM)).toBe(false);
    expect(playsDirectly(version({ videoCodec: null, width: null, height: null }), CHROMIUM)).toBe(
      false,
    );
    expect(playsDirectly(version({ videoProfile: "High 4:4:4" }), MAIN_AND_HIGH_ONLY)).toBe(false);
  });

  it("offers the demo film's direct edition in a browser, and the profile's last choice over it", () => {
    expect(Option.map(preferredVersion(featureTest(), CHROMIUM), (chosen) => chosen.id)).toEqual(
      Option.some("direct"),
    );
    expect(
      Option.map(preferredVersion(featureTest("sd"), CHROMIUM), (chosen) => chosen.id),
    ).toEqual(Option.some("sd"));
  });

  it("falls back to the best quality when nothing plays directly, and to none without versions", () => {
    const mkvOnly = featureTest().filter((candidate) => candidate.container === "mkv");

    expect(Option.map(preferredVersion(mkvOnly, CHROMIUM), (chosen) => chosen.id)).toEqual(
      Option.some("hdr"),
    );
    expect(Option.isNone(preferredVersion([], CHROMIUM))).toBe(true);
  });

  it("always picks one of the versions, the last played if any, else the best that plays directly", () => {
    fc.assert(
      fc.property(versions, (list) => {
        const chosen = Option.getOrUndefined(preferredVersion(list, CHROMIUM));

        if (chosen === undefined) return list.length === 0;

        const at = list.indexOf(chosen);
        const earlier = list.slice(0, at);

        if (at < 0) return false;

        if (list.some((candidate) => candidate.lastPlayed)) return chosen.lastPlayed;

        if (list.some((candidate) => playsDirectly(candidate, CHROMIUM))) {
          return (
            playsDirectly(chosen, CHROMIUM) &&
            !earlier.some((candidate) => playsDirectly(candidate, CHROMIUM))
          );
        }

        return at === 0;
      }),
    );
  });
});

describe("version labels", () => {
  it("names a version by its edition, else by its picture", () => {
    expect(label(version({ versionName: "Director's Cut" }))).toBe("Director's Cut");
    expect(label(version({ width: 3840, height: 2160, videoCodec: "hevc" }))).toBe("4K HEVC");
    expect(label(version({ width: 720, height: 576, videoCodec: "mpeg2video" }))).toBe("SD MPEG-2");
    expect(label(version({ width: null, height: null, videoCodec: null, container: "mkv" }))).toBe(
      "MKV",
    );
  });

  it("tells versions apart by picture, range, codecs, tracks, and size", () => {
    expect(
      detail(
        version({
          width: 3840,
          height: 2160,
          hdr: "hdr10",
          videoCodec: "hevc",
          audioCodec: "eac3",
          audioChannels: 6,
          sizeBytes: 41_200_000_000,
        }),
      ),
    ).toBe("4K · HDR10 · HEVC · EAC3 5.1 · 41.2 GB");
    expect(detail(version({ audioTracks: 3, sizeBytes: 640_000_000 }))).toBe(
      "1080p · H.264 · AAC 2.0 · 3 audio tracks · 640 MB",
    );
  });
});
