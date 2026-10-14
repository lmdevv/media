/** How long after a removal lands focus may still move to the row that took its place. */
export const FOCUS_WINDOW_MS = 2000;

/** A queue removal that landed and may move focus once the list shows it. */
export interface LandedRemoval {
  /** The removed row's place in the list. */
  readonly position: number;
  readonly trackId: string;
  /** How many rows held that song before the removal. */
  readonly countBefore: number;
  /** When the removal landed, in epoch milliseconds. */
  readonly landedAt: number;
}

/** What the list looks like now, for {@link focusMove}. */
export interface QueueFocusState {
  readonly now: number;
  /** The song IDs of the rows, in order. */
  readonly trackIds: ReadonlyArray<string>;
  /** Focus is on the page body or inside the queue list, so moving it takes it from nowhere. */
  readonly focusFree: boolean;
}

/**
 * What to do about a landed removal: `move` focus to the row now at its place (ADS-107), `wait`
 * for the list to show the removal, or `drop` it, once the window has passed or focus went
 * elsewhere, so a late update never takes focus from where the user is.
 */
export const focusMove = (
  removal: LandedRemoval,
  { now, trackIds, focusFree }: QueueFocusState,
): "move" | "wait" | "drop" => {
  if (now - removal.landedAt > FOCUS_WINDOW_MS || !focusFree) return "drop";

  const count = trackIds.filter((id) => id === removal.trackId).length;

  return count < removal.countBefore ? "move" : "wait";
};
