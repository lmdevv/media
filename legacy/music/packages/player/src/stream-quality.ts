import type { StreamProfile } from "@music/commands/models";

import type { EngineKind } from "./engine";

/**
 * The listener's streaming quality setting.
 *
 * With the gapless MSE engine:
 * - `lossless`: FLAC for lossless sources, AAC 256 kbps for lossy ones.
 * - `high`: AAC 256 kbps.
 *
 * With HTML audio (browsers without MSE, and always for data saver):
 * - `lossless`: the original file when this browser can decode it, else AAC 320 kbps.
 * - `high`: AAC 320 kbps.
 * - `data-saver`: AAC 128 kbps.
 */
export type StreamQuality = "lossless" | "high" | "data-saver";

/** Every quality setting, in the order a settings screen lists them. */
export const streamQualities: ReadonlyArray<StreamQuality> = ["lossless", "high", "data-saver"];

/** Parses a stored setting; anything unknown falls back to `lossless`. */
export const parseStreamQuality = (stored: string | null): StreamQuality =>
  streamQualities.find((quality) => quality === stored) ?? "lossless";

/**
 * The MIME type to ask `canPlayType` about for a track codec as the scanner records it, or null
 * when the codec is not one browsers play directly. Scanner codec names vary ("FLAC",
 * "MPEG 1 Layer 3", "MPEG-4/AAC", "Vorbis I", "PCM"), so this matches loosely.
 */
export const codecMimeType = (codec: string): string | null => {
  const name = codec.toLowerCase();

  if (name.includes("flac")) return "audio/flac";

  if (name.includes("alac")) return 'audio/mp4; codecs="alac"';

  if (name.includes("aac") || name.includes("mp4a")) return 'audio/mp4; codecs="mp4a.40.2"';

  if (name.includes("mp3") || name.includes("layer 3") || name.includes("layer iii")) {
    return "audio/mpeg";
  }

  if (name.includes("opus")) return 'audio/ogg; codecs="opus"';

  if (name.includes("vorbis")) return 'audio/ogg; codecs="vorbis"';

  if (name.includes("pcm") || name.includes("wav")) return "audio/wav";

  return null;
};

/**
 * Picks the stream profile for a track. `canPlay` answers whether this browser decodes a MIME
 * type (`audio.canPlayType(type) !== ""`).
 */
export const chooseStreamProfile = (
  quality: StreamQuality,
  codec: string,
  canPlay: (mimeType: string) => boolean,
): StreamProfile => {
  if (quality === "data-saver") return "aac-128";

  if (quality === "high") return "aac-320";
  const mimeType = codecMimeType(codec);

  return mimeType !== null && canPlay(mimeType) ? "original" : "aac-320";
};

/** What this browser's Media Source Extensions can play in fragmented MP4. AAC is required. */
export interface MseSupport {
  /** FLAC in MP4 (`audio/mp4; codecs="fLaC"`). */
  readonly flac: boolean;
  /** `SourceBuffer.changeType`: switch between FLAC and AAC without resetting playback. */
  readonly changeType: boolean;
}

/**
 * Which engine plays at this quality. The gapless MSE engine needs MSE support and has not
 * failed in this session; data saver always uses HTML audio and its 128 kbps transcode.
 */
export const chooseEngine = (
  quality: StreamQuality,
  support: MseSupport | null,
  mseFailed: boolean,
): EngineKind => (support === null || mseFailed || quality === "data-saver" ? "html" : "mse");

/**
 * Picks the fragmented profile for the MSE engine. Lossless sources get FLAC at `lossless`
 * quality when the browser decodes it. Without `changeType`, every song at `lossless` quality
 * gets FLAC (lossy sources are decoded and stored losslessly), so the codec never changes
 * mid-queue and playback never needs a reset between songs.
 */
export const chooseGaplessProfile = (
  quality: StreamQuality,
  lossless: boolean,
  support: MseSupport,
): "fmp4-flac" | "fmp4-aac" =>
  quality === "lossless" && support.flac && (lossless || !support.changeType)
    ? "fmp4-flac"
    : "fmp4-aac";
