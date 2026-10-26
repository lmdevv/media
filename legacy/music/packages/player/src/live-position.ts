/**
 * Where playback was at a moment in time: the part of the playback session that fixes it, or the
 * engine's last report on this device.
 */
export interface PositionSnapshot {
  /** Position in milliseconds that was true at `updatedAt`. */
  readonly positionMs: number;
  /**
   * When `positionMs` was recorded, in milliseconds on the clock `livePosition` reads `now` from:
   * the Unix epoch for the session's reports, the monotonic clock for the engine's.
   */
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
