/**
 * What AVPlayer on an iPhone plays, as the media service's negotiation reads it. AVPlayer has no
 * runtime codec query like a browser's `canPlayType`, so this is a fixed list of what iOS 17
 * decodes: MP4 and QuickTime files over byte ranges, H.264 up to level 5.2, HEVC Main and Main 10
 * with HDR10, HLG, and Dolby Vision, the audio codecs Core Audio decodes, and fMP4 HLS for
 * everything else. A file in another container (MKV, WebM, AVI) arrives remuxed into HLS.
 */
import type { ClientCapabilities } from "@media/contracts/media-playback";

/** H.264 level 5.2 in ffprobe units. */
const H264_MAX_LEVEL = 52;

/** The capabilities every negotiation from this app sends. */
export const IOS_CAPABILITIES = {
  containers: ["mp4", "mov"],
  videoCodecs: [
    { codec: "h264", maxLevel: H264_MAX_LEVEL, maxBitDepth: 8 },
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg", "dolby-vision"],
    },
  ],
  audioCodecs: [
    { codec: "aac", maxChannels: 8 },
    { codec: "ac3", maxChannels: 6 },
    { codec: "eac3", maxChannels: 8 },
    { codec: "mp3", maxChannels: 2 },
    { codec: "flac", maxChannels: 8 },
    { codec: "alac", maxChannels: 8 },
    { codec: "opus", maxChannels: 8 },
  ],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
} as const satisfies ClientCapabilities;
