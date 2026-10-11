/** The part of the playback session that fixes where playback is at a moment in time. */
export interface PositionSnapshot {
  /** Position in milliseconds that was true at `updatedAt`. */
  readonly positionMs: number;
  /** Milliseconds since the Unix epoch when `positionMs` was recorded. */
  readonly updatedAt: number;
  readonly playing: boolean;
}

/**
 * Where playback is at `now`: `positionMs + (now - updatedAt)` while playing, else `positionMs`.
 * Clamped to `[0, durationMs]` when the duration is known (greater than zero), so a stale report
 * or clock skew never shows a position past the end of the song.
 */
export const livePosition = (
  snapshot: PositionSnapshot,
  now: number,
  durationMs: number,
): number => {
  const elapsed = snapshot.playing ? Math.max(0, now - snapshot.updatedAt) : 0;
  const position = Math.max(0, snapshot.positionMs + elapsed);

  return durationMs > 0 ? Math.min(position, durationMs) : position;
};
