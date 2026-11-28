import type { ClientCapabilities, DynamicRange } from "./media-playback";
import type { HdrFormat } from "./models/catalog";

/** A video stream as direct play reads it. */
export interface DirectPlayVideo {
  /** ffmpeg codec name, such as `hevc`. */
  readonly codec: string;
  /** ffprobe profile name, such as `Main 10`; any profile passes when unknown. */
  readonly profile?: string | undefined;
  /** ffprobe level, such as 153 for HEVC 5.1; any level passes when unknown. */
  readonly level?: number | undefined;
  readonly bitDepth: number;
  readonly width: number;
  readonly height: number;
  readonly dynamicRange: DynamicRange;
  /**
   * A Dolby Vision stream's profile and base layer signal compatibility id, when the probe read its
   * configuration; what the base layer plays as depends on it (`playableAs`).
   */
  readonly dolbyVision?: { readonly profile: number; readonly compatibility: number } | undefined;
}

/** An audio track as direct play reads it. */
export interface DirectPlayAudio {
  /** ffmpeg codec name, such as `eac3`. */
  readonly codec: string;
  readonly channels: number;
}

/** A file's container and the streams a direct play would deliver: the video and the default audio. */
export interface DirectPlayFile {
  /** Container family: `mp4`, `mov`, `mkv`, `webm`, `avi`, `ts`, or `other`. */
  readonly container: string;
  readonly video: DirectPlayVideo | undefined;
  readonly audio: DirectPlayAudio | undefined;
}

type VideoCodecSupport = ClientCapabilities["videoCodecs"][number];

const CODEC_ALIASES: ReadonlyMap<string, string> = new Map([
  ["h265", "hevc"],
  ["avc", "h264"],
  ["avc1", "h264"],
  ["hev1", "hevc"],
  ["hvc1", "hevc"],
  ["vp09", "vp9"],
  ["av01", "av1"],
  ["mp4a", "aac"],
  ["ec-3", "eac3"],
  ["ac-3", "ac3"],
]);

/** A codec's ffmpeg name, lower-cased, for any of the names browsers and containers use. */
export const canonicalCodec = (codec: string): string => {
  const lower = codec.toLowerCase();

  return CODEC_ALIASES.get(lower) ?? lower;
};

/** What the client says about decoding `codec`, if it decodes it at all. */
export const videoSupport = (
  client: ClientCapabilities,
  codec: string,
): VideoCodecSupport | undefined =>
  client.videoCodecs.find((support) => canonicalCodec(support.codec) === canonicalCodec(codec));

/**
 * What a Dolby Vision base layer plays as for a player that does not apply Dolby Vision, by its
 * signal compatibility id: HDR10 (1, and 6 for profile 7's Blu-ray base layer), SDR (2), or HLG
 * (4). An id of 0 (profile 5's IPT-PQ-c2) or any other plays as nothing else.
 */
const BASE_LAYERS: ReadonlyMap<number, DynamicRange> = new Map([
  [1, "hdr10"],
  [2, "sdr"],
  [4, "hlg"],
  [6, "hdr10"],
]);

/**
 * The dynamic ranges a client may declare, any one of which lets it play `video` as stored; SDR
 * needs no declaration. A Dolby Vision stream plays for a client that declares Dolby Vision, and
 * for one that declares what its base layer is; profile 7 plays only as its HDR10 base layer, since
 * players outside Blu-ray do not apply its enhancement layer. One whose configuration was not read
 * plays only for Dolby Vision.
 */
export const playableAs = (
  video: Pick<DirectPlayVideo, "dynamicRange" | "dolbyVision">,
): ReadonlyArray<DynamicRange> => {
  if (video.dynamicRange !== "dolby-vision") return [video.dynamicRange];
  const config = video.dolbyVision;
  const base = config === undefined ? undefined : BASE_LAYERS.get(config.compatibility);

  if (config?.profile === 7) return base === undefined ? [] : [base];

  return base === undefined ? ["dolby-vision"] : ["dolby-vision", base];
};

/** Whether the client decodes and displays `video` as stored. */
export const decodesVideo = (client: ClientCapabilities, video: DirectPlayVideo): boolean => {
  const support = videoSupport(client, video.codec);

  if (support === undefined) return false;

  const profileOk =
    support.profiles === undefined ||
    video.profile === undefined ||
    support.profiles.some((profile) => profile.toLowerCase() === video.profile?.toLowerCase());

  const levelOk =
    support.maxLevel === undefined || video.level === undefined || video.level <= support.maxLevel;

  const depthOk = video.bitDepth <= (support.maxBitDepth ?? 8);

  const rangeOk = playableAs(video).some(
    (range) => range === "sdr" || (support.dynamicRanges ?? []).includes(range),
  );

  const sizeOk = video.width <= client.maxWidth && video.height <= client.maxHeight;

  return profileOk && levelOk && depthOk && rangeOk && sizeOk;
};

/** Whether the client decodes `track` as stored. */
export const decodesAudio = (client: ClientCapabilities, track: DirectPlayAudio): boolean =>
  client.audioCodecs.some(
    (support) =>
      canonicalCodec(support.codec) === canonicalCodec(track.codec) &&
      track.channels <= (support.maxChannels ?? 8),
  );

/**
 * Whether the client plays `file` as stored over byte ranges: its container, its video, and its
 * default audio track. A file without video never plays, as negotiation refuses it; negotiation
 * still encodes a direct file when the viewer caps the quality below it or burns in a subtitle.
 */
export const playsDirectly = (client: ClientCapabilities, file: DirectPlayFile): boolean =>
  client.containers.some((container) => container === file.container) &&
  file.video !== undefined &&
  decodesVideo(client, file.video) &&
  (file.audio === undefined || decodesAudio(client, file.audio));

const DYNAMIC_RANGES: Readonly<Record<HdrFormat, DynamicRange>> = {
  none: "sdr",
  // HDR10+ carries HDR10 for players without its dynamic metadata.
  hdr10: "hdr10",
  hdr10plus: "hdr10",
  hlg: "hlg",
  dolby_vision: "dolby-vision",
};

/** How negotiation names the dynamic range of a stream whose HDR format ffprobe reported. */
export const dynamicRangeOf = (hdr: HdrFormat): DynamicRange => DYNAMIC_RANGES[hdr];
