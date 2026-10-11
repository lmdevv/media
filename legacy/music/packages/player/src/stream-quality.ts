import type { StreamProfile } from "@music/commands/models";

/**
 * The listener's streaming quality setting.
 *
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
