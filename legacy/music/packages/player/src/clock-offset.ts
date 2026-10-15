/**
 * How far this device's clock runs ahead of the server's, for listening along to a Jam. The host's
 * position is stamped with server time; a device whose clock is off would play off by as much.
 *
 * Each time a new host report arrives, `arrival - updatedAt` is the clock offset plus however long
 * the report took to reach this device. The smallest of recent samples is the best estimate: the
 * one that waited least.
 */

/** Samples kept: enough to ride out a few slow deliveries, few enough to follow clock changes. */
const CLOCK_SAMPLES = 8;

/** `samples` with `sample` added, keeping the most recent ones. */
export const withClockSample = (
  samples: ReadonlyArray<number>,
  sample: number,
): ReadonlyArray<number> => [...samples, sample].slice(-CLOCK_SAMPLES);

/** The estimated offset in milliseconds (this device minus the server), or 0 without samples. */
export const clockOffset = (samples: ReadonlyArray<number>): number =>
  samples.length === 0 ? 0 : Math.min(...samples);
