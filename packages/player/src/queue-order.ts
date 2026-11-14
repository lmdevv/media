/**
 * Where the queue goes from the entry playing, as old music's server worked it out for
 * `playback.next` and `playback.previous` (`legacy/music/packages/commands/src/queue-rules.ts`).
 * The core keeps the queue and the entry playing; the player picks the entry and sends
 * `music.queue.jump`.
 */

/** Repeat off, the whole queue, or the song playing. */
export type RepeatMode = "off" | "all" | "one";

/** How far into a song `previous` starts it again instead of going back. */
export const RESTART_THRESHOLD_MS = 3000;

/** The entry `next` moves to, or null when the queue has run out. */
export const nextIndex = (index: number, length: number, repeat: RepeatMode): number | null => {
  if (index < length - 1) return index + 1;

  return repeat === "all" && length > 0 ? 0 : null;
};

/**
 * The entry `previous` moves to, given where the song is: the same one, from its start, once it
 * has played past the restart threshold; otherwise the one before, wrapping when repeat is all.
 */
export const previousIndex = (
  positionMs: number,
  index: number,
  length: number,
  repeat: RepeatMode,
): number => {
  if (positionMs > RESTART_THRESHOLD_MS) return index;

  if (index > 0) return index - 1;

  return repeat === "all" ? Math.max(0, length - 1) : 0;
};

/**
 * The entry that plays when the one at `index` ends by itself, which the gapless engine loads
 * ahead: none while repeat one plays the same song again, else the next one.
 */
export const followingIndex = (index: number, length: number, repeat: RepeatMode): number | null =>
  repeat === "one" ? null : nextIndex(index, length, repeat);
