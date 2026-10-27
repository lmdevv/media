/**
 * How synced lyrics follow playback in Now Playing (B12, B14): the sung line sits at the anchor
 * until anything other than following moves the lines (a drag, a tap on the status bar,
 * VoiceOver's three-finger scroll, even while paused), and from then on the lines are the
 * person's until they ask to follow again ("Back to current line", or tapping a line).
 */
import { Match } from "effect";

/** How far (in points) the lines may sit from where following put them and still count as there. */
const SCROLL_SLACK = 2;

/**
 * Following and where it has the lines, with `offset`, the last scroll position seen:
 * `waiting` to place the sung line once it is measured, `placed` at rest at `top`, `moving` while
 * a scroll to `top` is under way, or `released` to the person.
 */
export type LineFollow =
  | { readonly kind: "waiting"; readonly offset: number }
  | { readonly kind: "placed"; readonly offset: number; readonly top: number }
  | { readonly kind: "moving"; readonly offset: number; readonly top: number }
  | { readonly kind: "released"; readonly offset: number };

/** Following, before anything is measured: how the lyrics open. */
export const LINES_WAITING: LineFollow = { kind: "waiting", offset: 0 };

/**
 * What happened to the lines. `top` is the scroll position that puts the sung line at the anchor
 * now (`anchorTop`), or null while it is not measured.
 * - `started`: another line started.
 * - `laidOut`: the lines or the lyrics changed size.
 * - `follow`: the person asked to follow again.
 * - `scrolled`: the lines are at `offset`, whoever moved them.
 * - `dragged`: the person started dragging the lines.
 * - `scrollSettled`: a follow scroll had time to land. An end the scroll view reports may
 *   belong to an earlier scroll this one interrupted, so it only counts as `scrolled`.
 */
export type LineFollowEvent =
  | { readonly type: "started"; readonly top: number | null }
  | { readonly type: "laidOut"; readonly top: number | null }
  | { readonly type: "follow"; readonly top: number | null }
  | { readonly type: "scrolled"; readonly offset: number }
  | { readonly type: "dragged" }
  | { readonly type: "scrollSettled" };

/** A scroll for the lines to make: animated, or at once. */
export interface FollowScroll {
  readonly top: number;
  readonly animated: boolean;
}

/** The state after an event, and the scroll it calls for, if any. */
export interface LineFollowStep {
  readonly state: LineFollow;
  readonly scroll?: FollowScroll;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= SCROLL_SLACK;

/**
 * Takes the lines to `top`. Already there, they are placed; a scroll still under way toward
 * somewhere else is stopped there with a scroll that is not animated.
 */
const moveTo = (state: LineFollow, top: number, animated: boolean): LineFollowStep => {
  const { offset } = state;

  if (near(offset, top) && state.kind !== "moving") {
    return { state: { kind: "placed", offset, top } };
  }

  return {
    state: { kind: "moving", offset, top },
    scroll: { top, animated: animated && !near(offset, top) },
  };
};

/** The next state of following, and the scroll it calls for, after `event`. */
export const followLines = (state: LineFollow, event: LineFollowEvent): LineFollowStep =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      // Following moves the lines with an animation; a first placement or a new layout does not.
      started: ({ top }): LineFollowStep =>
        state.kind === "released" || top === null
          ? { state }
          : moveTo(state, top, state.kind !== "waiting"),
      laidOut: ({ top }): LineFollowStep =>
        state.kind === "released" || top === null ? { state } : moveTo(state, top, false),
      follow: ({ top }): LineFollowStep =>
        top === null
          ? { state: { kind: "waiting", offset: state.offset } }
          : moveTo(state, top, true),
      scrolled: ({ offset }): LineFollowStep => {
        if (state.kind === "placed" && !near(offset, state.top)) {
          return { state: { kind: "released", offset } };
        }

        if (state.kind === "moving" && near(offset, state.top)) {
          return { state: { kind: "placed", offset, top: state.top } };
        }

        return { state: { ...state, offset } };
      },
      dragged: (): LineFollowStep => ({ state: { kind: "released", offset: state.offset } }),
      // A follow scroll that has not reached its target by now was stopped by something else.
      scrollSettled: (): LineFollowStep => {
        if (state.kind !== "moving") return { state };

        return {
          state: near(state.offset, state.top)
            ? { kind: "placed", offset: state.offset, top: state.top }
            : { kind: "released", offset: state.offset },
        };
      },
    }),
  );

/** Where a line was laid out in the lines' scroll content. */
export interface LineBox {
  readonly y: number;
  readonly height: number;
}

/** The measured lyrics: the visible height, the content's height, and each line's box. */
export interface LinesLayout {
  readonly viewport: number;
  readonly content: number;
  readonly lines: ReadonlyArray<LineBox | undefined>;
}

/**
 * The scroll position that follows line `index`, or null until the lyrics and the lines it needs
 * are measured. The top edge never cuts a line: the line before the sung one either shows whole,
 * its top at the lead (where the first line sits), or is scrolled out whole, with the sung line at
 * the lead. Whichever keeps the sung line nearer B12's anchor wins: one shortest line below the
 * lead, as B12 shows a one-row line sung above it. A long line before the sung one scrolls out.
 * Before the first line, and at it, the lines sit at the top.
 */
export const anchorTop = (layout: LinesLayout, index: number): number | null => {
  if (layout.viewport === 0) return null;

  if (index <= 0) return index < 0 || layout.lines[0] !== undefined ? 0 : null;
  const line = layout.lines[index];
  const previous = layout.lines[index - 1];
  const lead = layout.lines[0]?.y;

  if (line === undefined || previous === undefined || lead === undefined) return null;
  const gap = line.y - previous.y - previous.height;
  const heights = layout.lines.flatMap((box) => (box === undefined ? [] : [box.height]));
  const anchor = lead + Math.min(...heights) + gap;
  const shown = previous.y - lead;
  const gone = Math.max(line.y - lead, previous.y + previous.height);
  const top = Math.abs(line.y - shown - anchor) <= Math.abs(line.y - gone - anchor) ? shown : gone;

  return Math.min(Math.max(0, top), Math.max(0, layout.content - layout.viewport));
};

/** Which way the sung line is from where the person scrolled: above the view, or below it. */
export type LineDirection = "up" | "down";

/**
 * Where "Back to current line" points (B14, B14b): up when the lines sit past `top`, the scroll
 * position that follows the sung line, so it is above the view; down when they sit before it.
 * Still at `top`, as when a drag has only just begun, it keeps pointing where it did (`shown`).
 */
export const lineDirection = (offset: number, top: number, shown: LineDirection): LineDirection => {
  if (near(offset, top)) return shown;

  return offset > top ? "up" : "down";
};
