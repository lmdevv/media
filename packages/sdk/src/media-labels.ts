import type { HdrFormat } from "@media/contracts/models/catalog";
import { Match } from "effect";

/** `4K`, `1080p`, or `720p` for a picture of that class; null below 720p. */
export const resolutionLabel = (width: number, height: number): string | null => {
  if (width >= 3200 || height >= 2000) return "4K";

  if (width >= 1800 || height >= 1000) return "1080p";

  if (width >= 1200 || height >= 700) return "720p";

  return null;
};

/** `HDR10`, `HDR10+`, `HLG`, or `DOLBY VISION`; null for SDR. */
export const hdrLabel = (hdr: HdrFormat): string | null =>
  Match.value(hdr).pipe(
    Match.when("none", () => null),
    Match.when("hdr10", () => "HDR10"),
    Match.when("hdr10plus", () => "HDR10+"),
    Match.when("hlg", () => "HLG"),
    Match.when("dolby_vision", () => "DOLBY VISION"),
    Match.exhaustive,
  );

const CODECS: ReadonlyMap<string, string> = new Map([
  ["hevc", "HEVC"],
  ["h265", "HEVC"],
  ["h264", "H.264"],
  ["avc", "H.264"],
  ["av1", "AV1"],
  ["vp9", "VP9"],
  ["mpeg2video", "MPEG-2"],
]);

/** `H.264`, `HEVC`, or the codec name upper-cased, such as `EAC3`. */
export const codecLabel = (codec: string): string =>
  CODECS.get(codec.toLowerCase()) ?? codec.toUpperCase();

/** `5.1` for six channels, `7.1` for eight, `2.0` for stereo; null without channels. */
export const channelLabel = (channels: number): string | null => {
  if (channels <= 0) return null;

  if (channels === 1) return "1.0";

  if (channels <= 2) return "2.0";

  return `${channels - 1}.1`;
};

/** A file size as people read it: `41.2 GB`, or `640 MB`. */
export const sizeLabel = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
