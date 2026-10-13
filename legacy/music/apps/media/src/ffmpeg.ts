/** Runs ffmpeg and ffprobe. Process spawning lives in `platform/node-process.ts`. */
import type { StreamProfile } from "@music/commands/models";
import { Effect, Schema, Stream } from "effect";

import { type ProcessResult, runProcess, spawnPiped } from "./platform/node-process.ts";

/** A media tool could not start, or exited unsuccessfully. */
export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Finite),
  /** Tail of the tool's standard error, which names files but never secrets. */
  stderr: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Media tool failed: ${this.command} exited with ${String(this.exitCode)}: ${this.stderr.trim().slice(-300)}`;
  }
}

/**
 * Runs a tool to completion; interruption kills it. Fails with `ProcessError` when it cannot
 * start or exits with a non-zero code.
 */
export const runTool = (
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<ProcessResult, ProcessError> =>
  Effect.tryPromise({
    try: (signal) => runProcess(command, args, signal),
    catch: (cause) => new ProcessError({ command, exitCode: null, stderr: "", cause }),
  }).pipe(
    Effect.filterOrFail(
      (result) => result.exitCode === 0,
      (result) =>
        new ProcessError({
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
          cause: null,
        }),
    ),
  );

/**
 * Runs a tool like `runTool` while handing each chunk it writes to file descriptor 3 (`pipe:3`)
 * to `onChunk`, in order and one at a time; the tool waits while `onChunk` runs. Fails with the
 * first `onChunk` failure (killing the tool), or like `runTool`.
 */
export const runToolPiped = <E, R>(
  command: string,
  args: ReadonlyArray<string>,
  onChunk: (chunk: Uint8Array) => Effect.Effect<void, E, R>,
): Effect.Effect<ProcessResult, ProcessError | E, R> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const controller = new AbortController();

      return { controller, child: spawnPiped(command, args, controller.signal) };
    }),
    // Kills the tool when the run stops early; a no-op once it has exited.
    ({ controller }) =>
      Effect.sync(() => {
        controller.abort();
      }),
  ).pipe(
    Effect.flatMap(({ child }) =>
      Effect.all(
        [
          Stream.fromAsyncIterable(
            child.output,
            (cause) => new ProcessError({ command, exitCode: null, stderr: "", cause }),
          ).pipe(Stream.runForEach(onChunk)),
          Effect.tryPromise({
            try: () => child.exit,
            catch: (cause) => new ProcessError({ command, exitCode: null, stderr: "", cause }),
          }),
        ],
        { concurrency: 2 },
      ),
    ),
    Effect.flatMap(([, result]) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new ProcessError({
              command,
              exitCode: result.exitCode,
              stderr: result.stderr,
              cause: null,
            }),
          ),
    ),
    Effect.scoped,
  );

/** Stream profiles the transcoder produces. */
export type TranscodeProfile = Exclude<StreamProfile, "original">;

/** Profiles written as fragmented MP4 for the gapless MSE engine. */
export type FragmentedProfile = Extract<TranscodeProfile, "fmp4-flac" | "fmp4-aac">;

/** True for the fragmented MP4 profiles, which carry sample timing. */
export const isFragmentedProfile = (profile: TranscodeProfile): profile is FragmentedProfile =>
  profile === "fmp4-flac" || profile === "fmp4-aac";

const BITRATES: Record<Exclude<TranscodeProfile, FragmentedProfile>, string> = {
  "aac-320": "320k",
  "aac-128": "128k",
};

/** Backslash-escapes what the tee muxer would read as syntax in an output name. */
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

/** Sample rates AAC LC supports up to 48 kHz; the gapless profile keeps these. */
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

/** Fragment length: playback can start once the first second of audio has arrived. */
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

/** Writes every decoded frame's sample count to standard output, one line per frame. */
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

/**
 * Sums the frame durations of a `framecrc` listing of decoded PCM: the exact number of samples
 * per channel. Lines look like `0, 0, 0, 4096, 32768, 0x1234abcd`; `#` lines are headers.
 */
export const countFrameSamples = (listing: string): number =>
  listing
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .reduce((total, line) => total + Number(line.split(",")[3]?.trim() ?? Number.NaN), 0);

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
