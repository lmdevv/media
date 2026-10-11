/**
 * Measures how cleanly a player joined the parts of one continuous sine. Any inserted silence,
 * lost audio, or repeated audio at a song boundary shifts the tone's phase there, so fitting the
 * phase on both sides gives the error in samples, with sub-sample precision.
 *
 * Pure: the harness page records the engine's output through Web Audio and analyzes it here.
 */

/** Below this the output counts as silent. The tones peak at 0.5. */
const SILENCE = 0.001;

/** Above this the output counts as sound when finding where the tone starts and stops. */
const SOUND = 0.01;

/** Samples on each side of a boundary that the phase fits use. */
const FIT_WINDOW = 6000;

/**
 * Samples next to a boundary the fits skip. A lossy codec smears the cut over up to one 2048
 * sample transform window; closer fits read that smear as a shift of a sample or two even in
 * ffmpeg's own decode of the files.
 */
const FIT_GUARD = 3000;

/** Samples on each side of a boundary searched for the largest residual. */
const RESIDUAL_WINDOW = 64;

/** What happened at one song boundary. */
interface BoundaryReading {
  /** Where the boundary should be, in output samples from the first sound. */
  readonly at: number;
  /**
   * Samples the tone is late after the boundary: positive for inserted silence or repeated
   * audio, negative for lost audio. Read modulo one period of the tone (within ±half a period);
   * `sampleError` catches anything larger.
   */
  readonly offsetSamples: number;
  /** Largest deviation from a pure sine near the boundary (second-order prediction residual). */
  readonly residual: number;
}

/** The measured output of one gapless sequence. */
export interface GapAnalysis {
  readonly sampleRate: number;
  /** Output samples from the tone's start to its end. */
  readonly soundSamples: number;
  readonly expectedSamples: number;
  /** `soundSamples - expectedSamples`: audio inserted (positive) or lost (negative) overall. */
  readonly sampleError: number;
  /**
   * Longest run of silence between the first and the last sound, in samples. A single sample can
   * fall under the threshold at a zero crossing of a clean tone.
   */
  readonly longestSilence: number;
  /** The residual that 99.9 % of samples away from boundaries stay under: the codec's noise. */
  readonly noiseFloor: number;
  readonly boundaries: ReadonlyArray<BoundaryReading>;
}

/** Phase of the best-fitting `a cos(ωn) + b sin(ωn)` over `[from, to)`, as `atan2(-b, a)`. */
const phaseOver = (samples: Float32Array, from: number, to: number, omega: number): number => {
  let cc = 0;
  let cs = 0;
  let ss = 0;
  let xc = 0;
  let xs = 0;

  for (let n = Math.max(0, from); n < Math.min(samples.length, to); n += 1) {
    const cos = Math.cos(omega * n);
    const sin = Math.sin(omega * n);
    const value = samples[n] ?? 0;
    cc += cos * cos;
    cs += cos * sin;
    ss += sin * sin;
    xc += value * cos;
    xs += value * sin;
  }

  const determinant = cc * ss - cs * cs;
  const a = (xc * ss - xs * cs) / determinant;
  const b = (cc * xs - cs * xc) / determinant;

  return Math.atan2(-b, a);
};

const wrap = (angle: number): number => {
  let wrapped = angle;

  while (wrapped > Math.PI) wrapped -= 2 * Math.PI;

  while (wrapped < -Math.PI) wrapped += 2 * Math.PI;

  return wrapped;
};

/**
 * Analyzes `samples` (one channel of the recorded output at `sampleRate`) that should hold a
 * `frequency` Hz sine cut at `cuts` (in source samples at `sourceRate`, first cut 0, last cut the
 * total length) and played back to back. The total must be a whole number of cycles, so the tone
 * starts and ends on a rising zero crossing.
 */
export const analyzeTone = (
  samples: Float32Array,
  sampleRate: number,
  frequency: number,
  cuts: ReadonlyArray<number>,
  sourceRate: number,
): GapAnalysis => {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const scale = sampleRate / sourceRate;
  let first = -1;
  let last = -1;

  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index] ?? 0) > SOUND) {
      if (first < 0) first = index;
      last = index;
    }
  }

  // The tone starts and ends on a rising zero crossing; fit the phase near each end and take the
  // crossing closest to where the output passes SOUND.
  const period = sampleRate / frequency;

  const crossingNear = (estimate: number, from: number, to: number): number => {
    const phase = phaseOver(samples, from, to, omega);
    const crossing = -(phase + Math.PI / 2) / omega;

    return crossing + Math.round((estimate - crossing) / period) * period;
  };

  const start = crossingNear(first, first + FIT_GUARD, first + FIT_GUARD + FIT_WINDOW);
  const end = crossingNear(last, last - FIT_GUARD - FIT_WINDOW, last - FIT_GUARD);
  const soundSamples = end - start;
  const expectedSamples = (cuts.at(-1) ?? 0) * scale;
  let silence = 0;
  let longestSilence = 0;

  for (let index = first; index <= last; index += 1) {
    if (Math.abs(samples[index] ?? 0) < SILENCE) {
      silence += 1;
      longestSilence = Math.max(longestSilence, silence);
    } else {
      silence = 0;
    }
  }

  const twoCos = 2 * Math.cos(omega);

  const residualAt = (n: number): number =>
    Math.abs((samples[n] ?? 0) - twoCos * (samples[n - 1] ?? 0) + (samples[n - 2] ?? 0));

  const positions = cuts.slice(1, -1).map((cut) => Math.round(start + cut * scale));

  const boundaries = positions.map((position, index) => {
    const before = phaseOver(
      samples,
      position - FIT_GUARD - FIT_WINDOW,
      position - FIT_GUARD,
      omega,
    );

    const after = phaseOver(
      samples,
      position + FIT_GUARD,
      position + FIT_GUARD + FIT_WINDOW,
      omega,
    );

    let residual = 0;

    for (let n = position - RESIDUAL_WINDOW; n <= position + RESIDUAL_WINDOW; n += 1) {
      residual = Math.max(residual, residualAt(n));
    }

    const at = (cuts[index + 1] ?? 0) * scale;

    return { at, offsetSamples: -wrap(after - before) / omega, residual };
  });

  const quiet: Array<number> = [];

  for (let n = first + FIT_GUARD; n <= last - FIT_GUARD; n += 1) {
    if (positions.every((position) => Math.abs(n - position) > FIT_GUARD))
      quiet.push(residualAt(n));
  }

  quiet.sort((left, right) => left - right);

  return {
    sampleRate,
    soundSamples,
    expectedSamples,
    sampleError: soundSamples - expectedSamples,
    longestSilence,
    noiseFloor: quiet[Math.floor(quiet.length * 0.999)] ?? 0,
    boundaries,
  };
};
