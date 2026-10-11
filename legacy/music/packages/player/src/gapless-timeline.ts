/**
 * Where each song sits on the MSE engine's single timeline. Songs are laid end to end: a song's
 * first real sample starts exactly where the previous song's last real sample ended. The
 * `SourceBuffer` maps each fragmented file onto that spot with `timestampOffset` (shifted back by
 * the encoder's priming samples) and cuts priming and padding with the append window. Pure.
 */
import { StreamTimingHeader } from "@music/commands/models";

import type { Fragment, SegmentIndex } from "./fmp4";

/** Sample timing of one fragmented stream, from its `X-Music-*` response headers. */
export interface StreamTiming {
  /** Encoder delay at the start of the file's timeline. */
  readonly primingSamples: number;
  /** Real samples after the priming; anything later is encoder padding. */
  readonly durationSamples: number;
  readonly sampleRate: number;
  /**
   * True while the stream is still being transcoded: `durationSamples` is only the source's
   * declared length, and the exact one comes from a `HEAD` request once the stream has ended.
   */
  readonly estimated: boolean;
}

/** How one song is placed on the timeline, in seconds. */
export interface Placement {
  /** Where its first real sample plays: the append window start. */
  readonly start: number;
  /** Where its last real sample ends: the append window end and the next song's start. */
  readonly end: number;
  /** The `SourceBuffer.timestampOffset` that maps the file's timeline onto `start`. */
  readonly timestampOffset: number;
}

const WHOLE = /^\d{1,15}$/u;

const whole = (value: string | null): number | null =>
  value !== null && WHOLE.test(value) ? Number(value) : null;

/**
 * Reads the timing headers. Returns null when any of the three numbers is missing or not a whole
 * number.
 */
export const parseStreamTiming = (header: (name: string) => string | null): StreamTiming | null => {
  const primingSamples = whole(header(StreamTimingHeader.priming));
  const durationSamples = whole(header(StreamTimingHeader.duration));
  const sampleRate = whole(header(StreamTimingHeader.sampleRate));

  if (primingSamples === null || durationSamples === null || sampleRate === null) return null;

  if (durationSamples === 0 || sampleRate === 0) return null;
  const estimated = header(StreamTimingHeader.estimated) === "1";

  return { primingSamples, durationSamples, sampleRate, estimated };
};

/** Places a song whose first real sample plays at `start` seconds. */
export const placeTrack = (timing: StreamTiming, start: number): Placement => ({
  start,
  end: start + timing.durationSamples / timing.sampleRate,
  timestampOffset: start - timing.primingSamples / timing.sampleRate,
});

/** The song's length in milliseconds, from its exact sample count. */
export const durationMs = (timing: StreamTiming): number =>
  (timing.durationSamples / timing.sampleRate) * 1000;

/**
 * The fragment to start fetching from so playback can begin at `positionSeconds` into the song:
 * the last fragment whose first sample is at or before that point.
 */
export const fragmentAt = (
  index: SegmentIndex,
  timing: StreamTiming,
  positionSeconds: number,
): Fragment | null => {
  const mediaTime =
    ((Math.max(0, positionSeconds) * timing.sampleRate + timing.primingSamples) /
      timing.sampleRate) *
    index.timescale;

  let found: Fragment | null = null;

  for (const fragment of index.fragments) {
    if (fragment.time > mediaTime) break;
    found = fragment;
  }

  return found ?? index.fragments[0] ?? null;
};

/**
 * The end of the range to evict so at most `keepSeconds` stay buffered behind the playhead, or
 * null when nothing needs to go. Evicting starts at `bufferedStart`.
 */
export const evictionEnd = (
  bufferedStart: number,
  currentTime: number,
  keepSeconds: number,
): number | null => {
  const end = currentTime - keepSeconds;

  return end > bufferedStart ? end : null;
};
