/**
 * Sample-exact timing of a fragmented MP4 transcode: how many priming samples its timeline starts
 * with and how many real samples follow. The gapless player trims with these numbers, so they are
 * measured from ffmpeg's output rather than assumed per codec.
 */
import { StreamTimingHeader } from "@music/commands/models";
import { Option, Schema } from "effect";

/** More priming than this means the measurement went wrong (AAC uses 1024, FLAC none). */
const MAX_PRIMING_SAMPLES = 16_384;

const Samples = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Timing stored beside each fragmented transcode and sent as response headers. */
export const SampleTiming = Schema.Struct({
  primingSamples: Samples,
  durationSamples: PositiveInt,
  sampleRate: PositiveInt,
});

export interface SampleTiming extends Schema.Schema.Type<typeof SampleTiming> {}

/**
 * Derives the timing from what ffmpeg reported. `timelineSamples` is the output stream's length
 * (`duration_ts` in samples), `decodedSamples` the decoded source length, and `tailPadding` the
 * silence appended before encoding. Priming is whatever the timeline holds beyond the decoded
 * samples and the appended tail. `declaredSamples` is the source container's own exact length
 * when it has one (MP4 edit lists), or null: older ffmpeg (6.x) decodes an AAC `.m4a` with its
 * end padding, and the declared length cuts that off. Returns none when the numbers do not add up.
 */
export const measureTiming = (
  timelineSamples: number,
  decodedSamples: number,
  tailPadding: number,
  sampleRate: number,
  declaredSamples: number | null,
): Option.Option<SampleTiming> => {
  const primingSamples = timelineSamples - decodedSamples - tailPadding;

  const realSamples =
    declaredSamples !== null && declaredSamples > 0 && declaredSamples < decodedSamples
      ? declaredSamples
      : decodedSamples;

  if (
    !Number.isSafeInteger(primingSamples) ||
    primingSamples < 0 ||
    primingSamples > MAX_PRIMING_SAMPLES ||
    !Number.isSafeInteger(realSamples) ||
    realSamples <= 0 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0
  ) {
    return Option.none();
  }

  return Option.some({ primingSamples, durationSamples: realSamples, sampleRate });
};

/** Containers whose declared stream length is exact (sample tables and edit lists). */
const EXACT_LENGTH_FORMATS = /\b(?:mov|mp4)\b/u;

const TIME_BASE = /^(\d+)\/(\d+)$/u;

/**
 * The source's declared length in output samples, from ffprobe's `format_name`, `duration_ts`,
 * and `time_base`, or null when the container does not declare an exact one. MP3 and Ogg
 * lengths are estimates and never count.
 */
export const declaredLength = (
  formatName: string,
  durationTs: number | undefined,
  timeBase: string,
  outputRate: number,
): number | null => {
  const base = TIME_BASE.exec(timeBase);

  if (!EXACT_LENGTH_FORMATS.test(formatName) || durationTs === undefined || base === null) {
    return null;
  }

  const numerator = Number(base[1]);
  const denominator = Number(base[2]);

  return denominator === 0 ? null : Math.round((durationTs * numerator * outputRate) / denominator);
};

/**
 * The source's length in output samples as it declares it, for a stream whose exact length is
 * not measured yet: the stream's `duration_ts` in `time_base` units, else the container's
 * duration in seconds, else one sample. An estimate: MP3 and Ogg containers only approximate it.
 */
export const estimatedLength = (
  durationTs: number | undefined,
  timeBase: string,
  formatSeconds: number | undefined,
  outputRate: number,
): number => {
  const base = TIME_BASE.exec(timeBase);
  const denominator = Number(base?.[2] ?? 0);

  const seconds =
    durationTs !== undefined && denominator > 0
      ? (durationTs * Number(base?.[1] ?? 0)) / denominator
      : (formatSeconds ?? 0);

  return Math.max(1, Math.round(seconds * outputRate));
};

/** The response headers that carry `timing`. */
export const timingHeaders = (timing: SampleTiming): ReadonlyArray<readonly [string, string]> => [
  [StreamTimingHeader.priming, String(timing.primingSamples)],
  [StreamTimingHeader.duration, String(timing.durationSamples)],
  [StreamTimingHeader.sampleRate, String(timing.sampleRate)],
];

/** The response headers of a stream sent while it is transcoded, whose length is estimated. */
export const estimatedTimingHeaders = (
  timing: SampleTiming,
): ReadonlyArray<readonly [string, string]> => [
  ...timingHeaders(timing),
  [StreamTimingHeader.estimated, "1"],
];
