/**
 * The ffmpeg and ffprobe arguments of music's transcodes, as old music's media service built them
 * (`ffmpeg.ts`): fast-start AAC for `<audio>`, fragmented FLAC and AAC for the gapless player, and
 * fresh encodes from an offset for a seek ahead of the cached transcode. Every run writes its
 * stream to file descriptor 3 (`pipe:3`), which `music-tools.ts` reads.
 */
import type { MusicStreamProfile } from "@media/contracts/music-playback";

/** Stream profiles the transcoder produces. */
export type TranscodeProfile = Exclude<MusicStreamProfile, "original">;

/** Profiles written as fragmented MP4 for the gapless MSE engine. */
export type FragmentedProfile = Extract<TranscodeProfile, "fmp4-flac" | "fmp4-aac">;

/** True for the fragmented MP4 profiles, which carry sample timing. */
export const isFragmentedProfile = (profile: TranscodeProfile): profile is FragmentedProfile =>
  profile === "fmp4-flac" || profile === "fmp4-aac";

const BITRATES: Record<Exclude<TranscodeProfile, FragmentedProfile>, string> = {
  "aac-320": "320k",
  "aac-128": "128k",
};

const teeEscape = (name: string): string => name.replaceAll(/[\\'|[\]]/gu, String.raw`\$&`);

/**
 * ffmpeg arguments that transcode the first audio stream of `source` to stereo 44.1 kHz AAC,
 * keeping tags and dropping cover art streams. The tee muxer writes the encoded stream twice: to
 * a fast-start MP4 (`.m4a`) at `destination`, whose `moov` ffmpeg moves to the front once the
 * file is complete, and as ADTS (`audio/aac`) to file descriptor 3 (`pipe:3`). ADTS frames carry
 * their own headers, so every byte of it is final the moment it is written and a player can
 * start on the first frame.
 */
export const transcodeArgs = (
  source: string,
  destination: string,
  profile: Exclude<TranscodeProfile, FragmentedProfile>,
): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-y",
  "-i",
  source,
  "-map",
  "0:a:0",
  "-c:a",
  "aac",
  "-b:a",
  BITRATES[profile],
  "-ar",
  "44100",
  "-ac",
  "2",
  "-map_metadata",
  "0",
  "-f",
  "tee",
  `[f=mp4:movflags=+faststart]${teeEscape(destination)}|[f=adts]pipe:3`,
];

/**
 * Digital silence appended to the input before AAC encoding. ffmpeg shortens the duration of the
 * last AAC frame in the container to the real samples, but decoders still output the whole
 * 1024-sample frame, and Chrome then plays the encoder's padding at a track boundary. With this
 * tail the last real sample sits inside a full-length frame, which the player's append window
 * cuts exactly; the silent frames after it are dropped whole.
 */
export const AAC_TAIL_PADDING = 2048;

const AAC_SAMPLE_RATES: ReadonlySet<number> = new Set([
  48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8000,
]);

/**
 * The output sample rate for `fmp4-aac`: the source's when AAC supports it, 44.1 kHz for higher
 * rates in that family (88.2, 176.4 kHz), and 48 kHz for everything else.
 */
export const aacSampleRate = (sourceRate: number): number => {
  if (AAC_SAMPLE_RATES.has(sourceRate)) return sourceRate;

  return sourceRate > 48_000 && sourceRate % 44_100 === 0 ? 44_100 : 48_000;
};

/**
 * Samples of encoder delay at the start of each fragmented profile's timeline: ffmpeg's AAC
 * encoder primes with one 1024-sample frame, FLAC with none. Known before encoding, so a stream
 * that is still being written can carry them; the transcoder checks them against what it
 * measures on the finished file.
 */
export const FRAGMENTED_PRIMING: Readonly<Record<FragmentedProfile, number>> = {
  "fmp4-flac": 0,
  "fmp4-aac": 1024,
};

const FRAGMENT_MICROSECONDS = "1000000";

const FRAGMENT_FLAGS = "+frag_keyframe+empty_moov+default_base_moof";

/**
 * The tee muxer writes the encoded stream twice. The file at `destination` gets a global `sidx`,
 * which ffmpeg inserts by rewriting the file once it is complete. The copy on `pipe:3` has no
 * index and no `mfra` trailer, so it is final the moment each byte is written; its fragments
 * are byte for byte the file's. A pipe also keeps ffmpeg from seeking back to patch box sizes,
 * which it does in a seekable file.
 */
const teeOutputs = (destination: string): ReadonlyArray<string> => [
  "-f",
  "tee",
  `[f=mp4:movflags=${FRAGMENT_FLAGS}+global_sidx:frag_duration=${FRAGMENT_MICROSECONDS}]` +
    `${teeEscape(destination)}|` +
    `[f=mp4:movflags=${FRAGMENT_FLAGS}+skip_trailer:frag_duration=${FRAGMENT_MICROSECONDS}]pipe:3`,
];

const COUNT_OUTPUT = ["-c:a", "pcm_s32le", "-f", "framecrc", "-"];

/**
 * ffmpeg arguments for a fragmented MP4 profile. The run writes the file at `destination` and,
 * as it goes, the same stream without its index to file descriptor 3 (see `teeOutputs`). It
 * also prints a `framecrc` listing of the decoded source (after the same resampling) to standard
 * output; `countFrameSamples` turns it into the exact number of real samples.
 *
 * - `fmp4-flac`: FLAC sources are remuxed untouched; other sources are encoded to FLAC.
 * - `fmp4-aac`: stereo AAC at 256 kbps and `aacRate` Hz (see `aacSampleRate`), with
 *   `AAC_TAIL_PADDING` samples of silence appended. The count output sees the same resampling.
 *
 * The file starts with `ftyp`, `moov`, and a global `sidx` indexing every fragment, so a player
 * can seek with one range request. No edit list is written (fragmented output never has one), so
 * the timeline starts with the encoder's priming samples; the player trims them using the
 * measured timing instead.
 */
export const fragmentedArgs = (
  source: string,
  destination: string,
  profile: FragmentedProfile,
  sourceCodec: string,
  aacRate: number,
): ReadonlyArray<string> => {
  const input = ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", source];

  if (profile === "fmp4-flac") {
    return [
      ...input,
      "-map",
      "0:a:0",
      "-c:a",
      sourceCodec === "flac" ? "copy" : "flac",
      "-map_metadata",
      "0",
      ...teeOutputs(destination),
      "-map",
      "0:a:0",
      ...COUNT_OUTPUT,
    ];
  }

  return [
    ...input,
    "-filter_complex",
    `[0:a:0]aresample=${aacRate},aformat=channel_layouts=stereo,asplit=2[count][encode];` +
      `[encode]apad=pad_len=${AAC_TAIL_PADDING}[padded]`,
    "-map",
    "[padded]",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-map_metadata",
    "0",
    ...teeOutputs(destination),
    "-map",
    "[count]",
    ...COUNT_OUTPUT,
  ];
};

/** Samples of encoder delay ffmpeg's AAC encoder starts every stream with. */
export const AAC_PRIMING = 1024;

/** The sample rate of the `aac-*` profiles. */
export const AAC_PROFILE_RATE = 44_100;

/**
 * How far before an offset ffmpeg starts decoding. MP3 frames lean on the frames before them (and
 * AAC and Opus frames overlap), so audio decoded right from a seek point starts with a glitch;
 * decoding from a little earlier and trimming by timestamp lands on the exact sample. Plain input
 * seeking alone is also off by hundreds of samples on AAC `.m4a` sources (ffmpeg 9).
 */
const OFFSET_PREROLL_SECONDS = 0.5;

const ffmpegSeconds = (seconds: number): string => seconds.toFixed(6);

/**
 * ffmpeg arguments that encode `source` from `startSeconds` into it and write a stream to file
 * descriptor 3 (`pipe:3`), for a listener who seeks ahead of the cached transcode. Nothing is
 * written to a file. The stream starts at the exact source sample wherever the source's
 * timestamps are exact (FLAC, WAV, MP3 with its gapless header, MP4).
 *
 * - `aac-320`, `aac-128`: ADTS, as the profiles' live stream; it starts with `AAC_PRIMING`
 *   samples of encoder delay.
 * - `fmp4-flac`: fragmented MP4 holding FLAC at the source rate (re-encoded even from FLAC, so the
 *   first frame starts exactly at the offset).
 * - `fmp4-aac`: fragmented MP4 holding AAC as `fragmentedArgs` encodes it, with the same tail
 *   padding; it starts with `AAC_PRIMING` samples of encoder delay.
 *
 * The fragmented streams have no index and no trailer; ffmpeg starts their decode times at zero.
 */
export const offsetArgs = (
  source: string,
  profile: TranscodeProfile,
  startSeconds: number,
  aacRate: number,
): ReadonlyArray<string> => {
  const preroll = Math.min(OFFSET_PREROLL_SECONDS, startSeconds);

  const input = [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-ss",
    ffmpegSeconds(startSeconds - preroll),
    "-i",
    source,
  ];

  const trim = `[0:a:0]atrim=start=${ffmpegSeconds(preroll)},asetpts=PTS-STARTPTS`;

  const fragmented = [
    "-f",
    "mp4",
    "-movflags",
    `${FRAGMENT_FLAGS}+skip_trailer`,
    "-frag_duration",
    FRAGMENT_MICROSECONDS,
    "pipe:3",
  ];

  if (profile === "fmp4-flac") {
    return [
      ...input,
      "-filter_complex",
      `${trim}[encode]`,
      "-map",
      "[encode]",
      "-c:a",
      "flac",
      ...fragmented,
    ];
  }

  if (profile === "fmp4-aac") {
    return [
      ...input,
      "-filter_complex",
      `${trim},aresample=${aacRate},aformat=channel_layouts=stereo,` +
        `apad=pad_len=${AAC_TAIL_PADDING}[encode]`,
      "-map",
      "[encode]",
      "-c:a",
      "aac",
      "-b:a",
      "256k",
      ...fragmented,
    ];
  }

  return [
    ...input,
    "-filter_complex",
    `${trim}[encode]`,
    "-map",
    "[encode]",
    "-c:a",
    "aac",
    "-b:a",
    BITRATES[profile],
    "-ar",
    String(AAC_PROFILE_RATE),
    "-ac",
    "2",
    "-f",
    "adts",
    "pipe:3",
  ];
};

/**
 * The running sum of the frame durations of a `framecrc` listing of decoded PCM, which arrives
 * in pieces of any size: the exact number of samples per channel. Lines look like
 * `0, 0, 0, 4096, 32768, 0x1234abcd`; `#` lines are headers. Only the unfinished last line is
 * kept, so an hour of hi-res audio does not hold megabytes of listing.
 */
export class FrameSampleCount {
  #partial = "";

  #total = 0;

  /** Adds the next piece of the listing. */
  push(text: string): void {
    const lines = `${this.#partial}${text}`.split("\n");

    this.#partial = lines.pop() ?? "";

    for (const line of lines) this.#count(line);
  }

  /** The samples in every line pushed so far, counting an unfinished last line as complete. */
  total(): number {
    this.#count(this.#partial);
    this.#partial = "";

    return this.#total;
  }

  #count(line: string): void {
    if (line.length === 0 || line.startsWith("#")) return;
    this.#total += Number(line.split(",")[3]?.trim() ?? Number.NaN);
  }
}

/** Sums the frame durations of a whole `framecrc` listing; see `FrameSampleCount`. */
export const countFrameSamples = (listing: string): number => {
  const count = new FrameSampleCount();

  count.push(listing);

  return count.total();
};

/**
 * ffprobe arguments that print the container format and duration, and the first audio stream's
 * sample rate and declared length (`duration_ts` in `time_base` units) of a source file.
 */
export const sourceProbeArgs = (path: string): ReadonlyArray<string> => [
  "-v",
  "error",
  "-select_streams",
  "a:0",
  "-show_entries",
  "stream=duration_ts,time_base,sample_rate:format=format_name,duration",
  "-of",
  "json",
  path,
];

/** ffprobe arguments that print the first audio stream's timeline length and sample rate. */
export const timelineProbeArgs = (path: string): ReadonlyArray<string> => [
  "-v",
  "error",
  "-select_streams",
  "a:0",
  "-show_entries",
  "stream=duration_ts,sample_rate",
  "-of",
  "json",
  path,
];
