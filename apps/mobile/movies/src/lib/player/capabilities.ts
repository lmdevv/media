/**
 * What AVPlayer on an iPhone plays, as the media service's negotiation reads it. AVPlayer has no
 * runtime codec query like a browser's `canPlayType`, so this is a fixed list of what iOS 17
 * decodes: MP4 and QuickTime files over byte ranges, H.264 up to level 5.2, HEVC Main and Main 10
 * with HDR10, HLG, and Dolby Vision, the audio codecs Core Audio decodes, and fMP4 HLS for
 * everything else. A file in another container (MKV, WebM, AVI) arrives remuxed into HLS. Every
 * iPhone decodes H.264 and HEVC in hardware; the list has no AV1, which only the newest decode.
 * AVPlayer decodes HDR on any screen and maps it to SDR on one that shows none, so what the screen
 * shows is asked of AVFoundation when the player opens (`capabilitiesOn`).
 */
import type { ClientCapabilities } from "@media/contracts/media-playback";

/** H.264 level 5.2 in ffprobe units. */
const H264_MAX_LEVEL = 52;

/** The capabilities every negotiation from this app sends, and on an HDR screen `capabilitiesOn`'s. */
export const IOS_CAPABILITIES = {
  containers: ["mp4", "mov"],
  videoCodecs: [
    { codec: "h264", maxLevel: H264_MAX_LEVEL, maxBitDepth: 8, powerEfficient: true },
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg", "dolby-vision"],
      powerEfficient: true,
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

/**
 * The capabilities a player on a screen that shows HDR (`screenShowsHdr`, AVFoundation's
 * `eligibleForHDRPlayback`) negotiates with: `IOS_CAPABILITIES`, and HDR10 and HLG on the screen,
 * so a stream the media service must re-encode keeps a source's HDR; on an SDR screen,
 * `IOS_CAPABILITIES` alone, and the service maps HDR to SDR itself.
 */
export const capabilitiesOn = (screenShowsHdr: boolean): ClientCapabilities =>
  screenShowsHdr ? { ...IOS_CAPABILITIES, hdrScreen: ["hdr10", "hlg"] } : IOS_CAPABILITIES;
