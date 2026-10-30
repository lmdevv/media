/**
 * Playback words and numbers as Paper prints them: scrubber times (B01 "2:18" and "−2:50"), audio
 * file details (B09 "FLAC · 16-bit / 44.1 kHz"), and device status lines (B05 "Online").
 */

/** The listener's streaming quality setting on this phone. */
type Quality = "lossless" | "high" | "data-saver";

/**
 * Whether the play button offers Pause: the player plays, or is loading or buffering a song it
 * will play. Paused, failed, and idle offer Play.
 */
export const playsOn = (status: string): boolean =>
  status === "playing" || status === "buffering" || status === "loading";

/** `m:ss`, or `h:mm:ss` from an hour, for a position in milliseconds. */
export const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
};

/** The time left, with Paper's true minus sign (U+2212): `−2:50`. */
export const remainingClock = (positionMs: number, durationMs: number): string =>
  `−${clock(Math.max(0, durationMs - Math.floor(positionMs / 1000) * 1000))}`;

/** How far through the song `positionMs` is, from 0 to 1. */
export const progressOf = (positionMs: number, durationMs: number): number =>
  durationMs <= 0 ? 0 : Math.min(1, Math.max(0, positionMs / durationMs));

const CODEC_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/flac/i, "FLAC"],
  [/alac|apple lossless/i, "ALAC"],
  [/layer ?3|mp3/i, "MP3"],
  [/aac|mp4a/i, "AAC"],
  [/opus/i, "Opus"],
  [/vorbis|ogg/i, "Vorbis"],
  [/pcm|wav/i, "WAV"],
];

/** The short name of a codec as the scanner reports it: `MPEG 1 Layer 3` is `MP3`. */
export const codecName = (codec: string): string =>
  CODEC_NAMES.find(([pattern]) => pattern.test(codec))?.[1] ?? codec;

/** A sample rate in hertz as kilohertz, with no needless decimal: `44.1`, `96`. */
const kilohertz = (sampleRate: number): string =>
  (sampleRate / 1000).toFixed(1).replace(/\.0$/, "");

/** The audio fields of a song, as the player carries them. */
export interface AudioFile {
  readonly codec: string;
  readonly lossless: boolean;
  /** Bits per second. */
  readonly bitrate: number | null;
  /** Hertz. */
  readonly sampleRate: number | null;
  readonly bitDepth: number | null;
}

/**
 * B09's file line: `FLAC · 16-bit / 44.1 kHz` for lossless files, `MP3 · 320 kbps / 44.1 kHz`
 * for lossy ones, leaving out what the scanner did not find.
 */
export const fileDetails = (file: AudioFile): string => {
  const depth = file.lossless && file.bitDepth !== null ? `${file.bitDepth}-bit` : null;

  const rate =
    !file.lossless && file.bitrate !== null ? `${Math.round(file.bitrate / 1000)} kbps` : null;

  const format = [
    depth ?? rate,
    file.sampleRate === null ? null : `${kilohertz(file.sampleRate)} kHz`,
  ]
    .filter((part) => part !== null)
    .join(" / ");

  return format === "" ? codecName(file.codec) : `${codecName(file.codec)} · ${format}`;
};

/**
 * The player bar's badge (page 26): `FLAC 24/96` for lossless files, `MP3 320` for lossy ones, or
 * the codec alone when the scanner found nothing more. Null with no codec at all.
 */
export const formatBadge = (file: AudioFile): string | null => {
  if (file.codec === "") return null;

  const name = codecName(file.codec).toUpperCase();

  if (!file.lossless) {
    return file.bitrate === null ? name : `${name} ${Math.round(file.bitrate / 1000)}`;
  }

  if (file.bitDepth === null || file.sampleRate === null) return name;

  return `${name} ${file.bitDepth}/${kilohertz(file.sampleRate)}`;
};

/** What VoiceOver reads for each repeat mode. */
export const REPEAT_LABELS = {
  off: "Repeat off",
  all: "Repeat all",
  one: "Repeat one",
} as const;

const QUALITY_NAMES = {
  lossless: "Lossless",
  high: "High quality",
  "data-saver": "Data saver",
} as const satisfies Record<Quality, string>;

/** The name of a streaming quality setting, as Settings › Playback lists it. */
export const qualityName = (quality: Quality): string => QUALITY_NAMES[quality];

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

/** A device row's status line (B05): `Playing now`, `Online`, or when it was last seen. */
export const deviceStatus = (
  device: { readonly active: boolean; readonly online: boolean; readonly lastSeenAt: number },
  now: number,
): string => {
  if (device.active) return "Playing now";

  if (device.online) return "Online";
  const ago = Math.max(0, now - device.lastSeenAt);

  if (ago < HOUR) return `Last seen ${Math.max(1, Math.floor(ago / MINUTE))} min ago`;

  if (ago < DAY) return `Last seen ${Math.floor(ago / HOUR)} h ago`;

  return "Last seen yesterday";
};
