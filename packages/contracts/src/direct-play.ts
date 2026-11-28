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
   * configuration; what the base layer plays as depends on it (`dolbyVisionBase`).
   */
  readonly dolbyVision?: { readonly profile: number; readonly compatibility: number } | undefined;
  /** Whether a Dolby Vision stream's first picture carries an RPU. */
  readonly dolbyVisionRpu?: true | undefined;
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

/** Profile 8's base layers by signal compatibility id: HDR10 (1), SDR (2), and HLG (4). */
const PROFILE_8_BASES: ReadonlyMap<number, DynamicRange> = new Map([
  [1, "hdr10"],
  [2, "sdr"],
  [4, "hlg"],
]);

/**
 * What a Dolby Vision stream's base layer plays as for a player that does not apply Dolby Vision,
 * decided from the profile first and then the signal compatibility id, the stricter reading where
 * they disagree: profile 7's HDR10 (its Blu-ray id, 6) and profile 8's HDR10, SDR, or HLG (1, 2, 4),
 * each in HEVC. Profile 5 has none whatever its id says, since its samples are IPT-PQ-c2; nor has
 * any other profile, id, or codec, nor a stream whose configuration was not read.
 */
export const dolbyVisionBase = (
  video: Pick<DirectPlayVideo, "codec" | "dolbyVision">,
): DynamicRange | undefined => {
  const config = video.dolbyVision;

  if (config === undefined || canonicalCodec(video.codec) !== "hevc") return undefined;

  if (config.profile === 7) return config.compatibility === 6 ? "hdr10" : undefined;

  return config.profile === 8 ? PROFILE_8_BASES.get(config.compatibility) : undefined;
};

/** Whether `video` is Dolby Vision 5 in HEVC, by its configuration. */
const isProfile5 = (video: Pick<DirectPlayVideo, "codec" | "dolbyVision">): boolean =>
  video.dolbyVision?.profile === 5 && canonicalCodec(video.codec) === "hevc";

/**
 * How a stream reaches a client: `stored`, the original file's bytes over byte ranges, any Dolby
 * Vision configuration record in them included; or `copied`, its packets remuxed, which keeps that
 * record for a client that declares Dolby Vision and drops it for one that does not.
 */
export type Delivery = "stored" | "copied";

/**
 * The dynamic ranges a client may declare, any one of which lets it play `video` delivered as
 * `delivery`; SDR needs no declaration. A stream that is not Dolby Vision plays as its own range.
 * For Dolby Vision:
 * - Profile 8 with a base layer (`dolbyVisionBase`) plays as stored only for Dolby Vision, since
 *   the original keeps its record and its sample entry may be `dvh1`; copied, for Dolby Vision or
 *   as its base layer, the record dropped.
 * - Profile 7 never plays as stored: AVFoundation, which declares Dolby Vision, fails to decode it
 *   with its record. Copied, it plays as its HDR10 base layer, the record dropped.
 * - Profile 5 plays, stored or copied, only for Dolby Vision, and only when its first picture
 *   carries the RPU that says what its samples mean.
 * - Any other profile, id, or codec, or a stream whose configuration was not read, plays as
 *   neither: only a conversion that reads its RPU shows it.
 */
export const playableAs = (
  video: Pick<DirectPlayVideo, "codec" | "dynamicRange" | "dolbyVision" | "dolbyVisionRpu">,
  delivery: Delivery,
): ReadonlyArray<DynamicRange> => {
  if (video.dynamicRange !== "dolby-vision") return [video.dynamicRange];

  if (isProfile5(video)) return video.dolbyVisionRpu === true ? ["dolby-vision"] : [];

  const base = dolbyVisionBase(video);

  if (base === undefined) return [];

  if (video.dolbyVision?.profile === 7) return delivery === "copied" ? [base] : [];

  return delivery === "copied" ? ["dolby-vision", base] : ["dolby-vision"];
};

/** Whether the client decodes and displays `video` delivered as `delivery` (`playableAs`). */
export const decodesVideo = (
  client: ClientCapabilities,
  video: DirectPlayVideo,
  delivery: Delivery,
): boolean => {
  const support = videoSupport(client, video.codec);

  if (support === undefined) return false;

  const profileOk =
    support.profiles === undefined ||
    video.profile === undefined ||
    support.profiles.some((profile) => profile.toLowerCase() === video.profile?.toLowerCase());

  const levelOk =
    support.maxLevel === undefined || video.level === undefined || video.level <= support.maxLevel;

  const depthOk = video.bitDepth <= (support.maxBitDepth ?? 8);

  const rangeOk = playableAs(video, delivery).some(
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
  decodesVideo(client, file.video, "stored") &&
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
