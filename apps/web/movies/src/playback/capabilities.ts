/**
 * What this browser can play, as the media service's negotiation reads it, and how to narrow it
 * after a path failed. Browser answers are hints: `canPlayType` says "maybe" for containers it
 * often cannot play, so only a "probably" counts for progressive containers, while codecs count
 * when Media Source Extensions accept them. A path that fails anyway is dropped with
 * `withoutFailedPath` and playback renegotiates.
 */
import type { ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";
import { Struct } from "effect";

/** The browser checks capability detection needs, so tests can describe any browser. */
export interface MediaSupport {
  /** `HTMLMediaElement.canPlayType`: `""`, `"maybe"`, or `"probably"`. */
  readonly canPlayType: (type: string) => string;
  /** `MediaSource.isTypeSupported` (or `ManagedMediaSource`), or null without Media Source Extensions. */
  readonly isTypeSupported: ((type: string) => boolean) | null;
  /** The display shows high dynamic range (`(dynamic-range: high)`). */
  readonly hdrDisplay: boolean;
}

type VideoCodecSupport = ClientCapabilities["videoCodecs"][number];

type AudioCodecSupport = ClientCapabilities["audioCodecs"][number];

const MAX_SIZE = { width: 3840, height: 2160 } as const;

/** H.264 at level 5.1, 5.0, and 4.1, as `avc1` strings and ffprobe levels. */
const H264_LEVELS: ReadonlyArray<readonly [string, number]> = [
  ["avc1.640033", 51],
  ["avc1.640032", 50],
  ["avc1.640029", 41],
  ["avc1.42E01E", 30],
];

interface CodecProbe {
  readonly codec: string;
  readonly eightBit: string;
  readonly tenBit: string | null;
}

const VIDEO_PROBES: ReadonlyArray<CodecProbe> = [
  { codec: "hevc", eightBit: "hvc1.1.6.L153.B0", tenBit: "hvc1.2.4.L153.B0" },
  { codec: "av1", eightBit: "av01.0.08M.08", tenBit: "av01.0.08M.10" },
  { codec: "vp9", eightBit: "vp09.00.40.08", tenBit: "vp09.02.40.10" },
];

const AUDIO_PROBES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["aac", ['audio/mp4; codecs="mp4a.40.2"']],
  ["mp3", ["audio/mpeg", 'audio/mp4; codecs="mp4a.6B"']],
  ["opus", ['audio/mp4; codecs="opus"', 'audio/webm; codecs="opus"']],
  ["flac", ['audio/mp4; codecs="flac"', "audio/flac"]],
  ["ac3", ['audio/mp4; codecs="ac-3"']],
  ["eac3", ['audio/mp4; codecs="ec-3"']],
  ["vorbis", ['audio/webm; codecs="vorbis"']],
];

const CONTAINER_PROBES: ReadonlyArray<readonly [ClientCapabilities["containers"][number], string]> =
  [
    ["mp4", "video/mp4"],
    ["mov", "video/quicktime"],
    ["webm", "video/webm"],
    ["mkv", "video/x-matroska"],
  ];

const videoType = (codecs: string): string => `video/mp4; codecs="${codecs}"`;

const decodes = (support: MediaSupport, type: string): boolean =>
  (support.isTypeSupported?.(type) ?? false) || support.canPlayType(type) === "probably";

const h264Support = (support: MediaSupport): VideoCodecSupport | null => {
  const level = H264_LEVELS.find(([codecs]) => decodes(support, videoType(codecs)));

  return level === undefined ? null : { codec: "h264", maxLevel: level[1], maxBitDepth: 8 };
};

const videoSupport = (support: MediaSupport, probe: CodecProbe): VideoCodecSupport | null => {
  if (!decodes(support, videoType(probe.eightBit))) return null;

  const tenBit = probe.tenBit !== null && decodes(support, videoType(probe.tenBit));

  if (!tenBit) return { codec: probe.codec, maxBitDepth: 8 };

  return {
    codec: probe.codec,
    maxBitDepth: 10,
    dynamicRanges: support.hdrDisplay ? ["hdr10", "hlg"] : [],
  };
};

const audioSupport = (support: MediaSupport): ReadonlyArray<AudioCodecSupport> =>
  AUDIO_PROBES.flatMap(([codec, types]) =>
    types.some((type) => decodes(support, type)) ? [{ codec, maxChannels: 8 }] : [],
  );

/**
 * The capabilities to negotiate with. HLS counts as native when the element plays it and Media
 * Source Extensions are missing (as on iPhones before ManagedMediaSource); with MSE, hls.js plays
 * it instead, which reports precise errors.
 */
export const detectCapabilities = (support: MediaSupport): ClientCapabilities => {
  const h264 = h264Support(support);

  const others = VIDEO_PROBES.flatMap((probe) => {
    const found = videoSupport(support, probe);

    return found === null ? [] : [found];
  });

  const mse = support.isTypeSupported !== null;

  return {
    containers: CONTAINER_PROBES.flatMap(([container, type]) =>
      support.canPlayType(type) === "probably" ||
      (container !== "mkv" && support.canPlayType(type) === "maybe")
        ? [container]
        : [],
    ),
    videoCodecs: h264 === null ? others : [h264, ...others],
    audioCodecs: audioSupport(support),
    maxWidth: MAX_SIZE.width,
    maxHeight: MAX_SIZE.height,
    hls: support.canPlayType("application/vnd.apple.mpegurl") !== "",
    mse,
  };
};

/**
 * The capabilities without the path that just failed, so renegotiating picks the next rung: a
 * failed direct file drops progressive playback, and a failed copied stream drops its video codec
 * (except H.264, which every transcode produces). Null when nothing is left to drop.
 */
export const withoutFailedPath = (
  capabilities: ClientCapabilities,
  stream: Pick<NegotiateResponse, "mode" | "video">,
): ClientCapabilities | null => {
  if (stream.mode === "direct") {
    return capabilities.containers.length === 0
      ? null
      : Struct.evolve(capabilities, { containers: () => [] });
  }

  if (stream.mode === "remux" || stream.mode === "audio-transcode") {
    if (stream.video.codec === "h264") return null;

    const videoCodecs = capabilities.videoCodecs.filter(
      (support) => support.codec !== stream.video.codec,
    );

    return videoCodecs.length === capabilities.videoCodecs.length
      ? null
      : Struct.evolve(capabilities, { videoCodecs: () => videoCodecs });
  }

  return null;
};
