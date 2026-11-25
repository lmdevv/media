/** Where each segment starts, and where the last one ends. */
export interface SegmentPlan {
  /** Start of each segment, ascending. Segment `i` covers `[starts[i], starts[i + 1] ?? end)`. */
  readonly starts: ReadonlyArray<number>;
  readonly end: number;
}

const SEGMENT_SECONDS = 4;

const MIN_TAIL_SECONDS = 0.5;

const QUICK_GRID_OFFSETS: ReadonlyArray<number> = [1, 2, 4, 6];

const QUICK_COPY_SECONDS = 8;

const QUICK_COPY_MIN_SECONDS = 1;

/** Where a session starts, which its first segments are cut short around. */
export interface PlanOptions {
  /** Start position on the source timeline; none plans plain segments throughout. */
  readonly quickStart?: number;
}

const withoutShortTail = (starts: ReadonlyArray<number>, end: number): ReadonlyArray<number> =>
  starts.length > 1 && end - (starts.at(-1) ?? end) < MIN_TAIL_SECONDS
    ? starts.slice(0, -1)
    : starts;

/**
 * Fixed-length segments from `start` for `duration` seconds; the two grid cells from
 * `options.quickStart` are cut into 1, 1, 2, 2, and 2 second segments.
 */
export const planGridSegments = (
  start: number,
  duration: number,
  options: PlanOptions = {},
): SegmentPlan => {
  const count = Math.max(1, Math.ceil(duration / SEGMENT_SECONDS));
  const end = start + duration;
  // Offsets from `start` are whole seconds, so equal boundaries compare equal before `start` is
  // added once; adding it to each part separately can round two equal times apart.
  const grid = Array.from({ length: count }, (_, index) => index * SEGMENT_SECONDS);

  const cell =
    options.quickStart === undefined
      ? undefined
      : Math.min(
          count - 1,
          Math.max(0, Math.floor((options.quickStart - start) / SEGMENT_SECONDS)),
        );

  const quick =
    cell === undefined ? [] : QUICK_GRID_OFFSETS.map((offset) => cell * SEGMENT_SECONDS + offset);

  const starts = [...new Set([...grid, ...quick])]
    .filter((offset) => start + offset < end)
    .toSorted((left, right) => left - right)
    .map((offset) => start + offset);

  return { starts: withoutShortTail(starts, end), end };
};

/**
 * Keyframe-aligned segments: each starts on a keyframe and lasts at least the target length,
 * except the last. From the keyframe at or before `options.quickStart`, segments hold one
 * keyframe each (at least a second) for eight seconds. `keyframes` must be ascending.
 */
export const planKeyframeSegments = (
  keyframes: ReadonlyArray<number>,
  start: number,
  duration: number,
  options: PlanOptions = {},
): SegmentPlan => {
  const end = start + duration;
  const usable = keyframes.filter((time) => time < end);
  const starts: Array<number> = [];
  const { quickStart } = options;

  const quickFrom =
    quickStart === undefined
      ? undefined
      : (usable.findLast((time) => time <= quickStart) ?? usable[0]);

  const isQuick = (time: number): boolean =>
    quickFrom !== undefined && time >= quickFrom && time < quickFrom + QUICK_COPY_SECONDS;

  for (const time of usable) {
    const previous = starts.at(-1);

    if (
      previous === undefined ||
      time === quickFrom ||
      (isQuick(previous) && time >= previous + QUICK_COPY_MIN_SECONDS) ||
      time >= previous + SEGMENT_SECONDS
    ) {
      starts.push(time);
    }
  }

  return { starts: withoutShortTail(starts.length === 0 ? [start] : starts, end), end };
};

/** Index of the segment containing `seconds`, clamped to the plan. */
export const segmentAt = (plan: SegmentPlan, seconds: number): number => {
  let low = 0;
  let high = plan.starts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if ((plan.starts[middle] ?? Number.POSITIVE_INFINITY) <= seconds) low = middle;
    else high = middle - 1;
  }

  return low;
};

const segmentDuration = (plan: SegmentPlan, index: number): number =>
  (plan.starts[index + 1] ?? plan.end) - (plan.starts[index] ?? plan.end);

/**
 * How far a fragment's start may sit from the planned start it was cut at: the keyframe index
 * and the muxer round the same keyframe's time a millisecond or so apart.
 */
const FRAGMENT_EPSILON_SECONDS = 0.005;

/**
 * The planned segments a generation's fragments make up, each fragment in the segment its start
 * falls in and none before `startSegment`. A fragment's start is its keyframe's own presentation
 * time, as the plan's starts are, even when leading pictures presented before the keyframe follow
 * it in the fragment. Fragments before the last one that starts by `from` are left out: ffmpeg's
 * stream-copy seek can start a keyframe or more before `from`, and a keyframe index a few
 * milliseconds late puts `from` just after the fragment that starts the segment. `fragments` must
 * be in start order.
 */
export const groupFragments = <F extends { readonly start: number }>(
  plan: SegmentPlan,
  startSegment: number,
  from: number,
  fragments: ReadonlyArray<F>,
): ReadonlyMap<number, ReadonlyArray<F>> => {
  const lead = fragments.findLastIndex(
    (fragment) => fragment.start <= from + FRAGMENT_EPSILON_SECONDS,
  );

  const members = new Map<number, ReadonlyArray<F>>();

  for (const fragment of fragments.slice(Math.max(0, lead))) {
    const index = Math.max(
      startSegment,
      segmentAt(plan, fragment.start + FRAGMENT_EPSILON_SECONDS),
    );

    members.set(index, [...(members.get(index) ?? []), fragment]);
  }

  return members;
};

/** How far the fragments written so far reach toward the next planned start. */
export interface Reach {
  /** A fragment starts at or after the next start, so the encoder got past it. */
  readonly followed: boolean;
  /**
   * A fragment ends at the next start, so the segment before it is whole. An end well past the
   * next start is not trusted, as ffmpeg did not cut there, and neither is an end short of it:
   * the next keyframe's leading pictures, presented before it, may follow in the next fragment.
   */
  readonly written: boolean;
}

/**
 * How far `fragments` reach toward `next`, the start of the segment after the one awaited. Each
 * fragment's start is its keyframe's presentation time and its end the latest presentation end of
 * its pictures (see `FragmentSpan`).
 */
export const reachOf = (
  fragments: ReadonlyArray<{ readonly start: number; readonly end: number | undefined }>,
  next: number | undefined,
): Reach => {
  if (next === undefined) return { followed: false, written: false };

  const followed = fragments.some((fragment) => fragment.start + FRAGMENT_EPSILON_SECONDS >= next);

  return {
    followed,
    written:
      followed ||
      fragments.some(
        (fragment) =>
          fragment.end !== undefined && Math.abs(fragment.end - next) <= FRAGMENT_EPSILON_SECONDS,
      ),
  };
};

/** URIs a rendered playlist points at, relative to the playlist itself. */
export interface PlaylistUris {
  readonly init: string;
  readonly segment: (index: number) => string;
}

/** Renders a complete VOD media playlist for fMP4 segments. */
export const renderPlaylist = (plan: SegmentPlan, uris: PlaylistUris): string => {
  const durations = plan.starts.map((_, index) => segmentDuration(plan, index));
  const target = Math.max(1, Math.ceil(Math.max(...durations)));

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${uris.init}"`,
    ...durations.flatMap((duration, index) => [
      `#EXTINF:${duration.toFixed(6)},`,
      uris.segment(index),
    ]),
    "#EXT-X-ENDLIST",
  ];

  return `${lines.join("\n")}\n`;
};
