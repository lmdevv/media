const CLOCK_SAMPLES = 8;

/** `samples` with `sample` added, keeping the most recent ones. */
export const withClockSample = (
  samples: ReadonlyArray<number>,
  sample: number,
): ReadonlyArray<number> => [...samples, sample].slice(-CLOCK_SAMPLES);

/** The estimated offset in milliseconds (this device minus the server), or 0 without samples. */
export const clockOffset = (samples: ReadonlyArray<number>): number =>
  samples.length === 0 ? 0 : Math.min(...samples);
