/**
 * Which of AVPlayer's reported positions to believe. When its stream disappears AVPlayer raises no
 * error: it skips the segments that fail to the end of the playlist, or resets its clock to zero
 * while it reloads. Neither is where the viewer is, so neither may be saved as progress or used to
 * restart the stream. A position is believed when the playhead could have played there from the
 * last believed one, or when it plays on from a jump for a few seconds (a seek from the lock
 * screen moves AVPlayer without the app).
 *
 * Times are on a clock that runs only while AVPlayer plays: time spent paused, stalled, or loading
 * plays nothing, so a skip after it cannot pass for playing.
 */

interface Sighting {
  readonly positionMs: number;
  readonly atMs: number;
}

interface Jump {
  readonly first: Sighting;
  readonly last: Sighting;
  /** How much media the player could have played from `first` to `last`, at the rates it played at. */
  readonly playableMs: number;
}

/** What the tracker believes about the playhead. */
export interface Playhead {
  /** The last position the player played to, or a seek the app asked for moved it to. */
  readonly believed: Sighting;
  /** A jump the player made on its own, believed once it has played on from there long enough. */
  readonly jump: Jump | null;
}

/**
 * How far behind the believed position a report may land: a seek or a new stream starts at the
 * keyframe or segment before its target.
 */
const BEHIND_MS = 10_000;

const AHEAD_MS = 2_000;

const JUMP_BELIEVED_AFTER_MS = 3_000;

const SLOWEST_RATE = 0.25;

/** A playhead known to be at `positionMs` at `atMs`: a new stream's start, or a seek. */
export const placed = (positionMs: number, atMs: number): Playhead => ({
  believed: { positionMs, atMs },
  jump: null,
});

const playsOnFrom = (from: Sighting, positionMs: number, reachMs: number): boolean =>
  positionMs >= from.positionMs - BEHIND_MS && positionMs <= from.positionMs + reachMs + AHEAD_MS;

/**
 * Whether the player could have played to `positionMs` by `atMs` from the believed position. Time
 * counts from the latest report: a player stuck somewhere else does not get closer by waiting.
 */
export const believes = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): boolean => {
  const fromMs = playhead.jump?.last.atMs ?? playhead.believed.atMs;

  return playsOnFrom(playhead.believed, positionMs, Math.max(0, atMs - fromMs) * Math.max(rate, 1));
};

/**
 * Whether `positionMs` is where the player is known to be heading: a believed position, or a jump
 * it made on its own and may still play on from.
 */
export const explains = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): boolean =>
  believes(playhead, positionMs, atMs, rate) ||
  extendedJump(playhead, { positionMs, atMs }, rate) !== null;

const playableTo = (jump: Jump, atMs: number, rate: number): number =>
  jump.playableMs + Math.max(0, atMs - jump.last.atMs) * rate;

/**
 * The jump the player made on its own, played on to `sighting` at `rate`; null when it made none or
 * did not. It must have played there from where it landed, so a skip in short steps is not one
 * jump. Each stretch counts at the rate of the report ending it, so a rate change must be sighted.
 */
const extendedJump = (playhead: Playhead, sighting: Sighting, rate: number): Jump | null => {
  const jump = playhead.jump;

  if (jump === null) return null;

  const playableMs = playableTo(jump, sighting.atMs, rate);
  const reachMs = Math.max(playableMs, sighting.atMs - jump.first.atMs);

  return playsOnFrom(jump.first, sighting.positionMs, reachMs)
    ? { first: jump.first, last: sighting, playableMs }
    : null;
};

const playsOn = (jump: Jump): boolean =>
  jump.last.positionMs - jump.first.positionMs >= (jump.last.atMs - jump.first.atMs) * SLOWEST_RATE;

/** The playhead after the player reported `positionMs` at `atMs`, playing at `rate`. */
export const reported = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): Playhead => {
  const sighting = { positionMs, atMs };

  if (believes(playhead, positionMs, atMs, rate)) {
    return { believed: sighting, jump: null };
  }

  const jump = extendedJump(playhead, sighting, rate) ?? {
    first: sighting,
    last: sighting,
    playableMs: 0,
  };

  const playedMs = jump.last.atMs - jump.first.atMs;

  return playedMs >= JUMP_BELIEVED_AFTER_MS && playsOn(jump)
    ? { believed: sighting, jump: null }
    : { believed: playhead.believed, jump };
};

/**
 * The playhead with the playing time until `atMs` counted at `rate`, the rate AVPlayer played at
 * before it changes. It takes no position: a reading of AVPlayer then is no report of where it is.
 */
export const accrued = (playhead: Playhead, atMs: number, rate: number): Playhead => {
  const jump = playhead.jump;

  if (jump === null) return playhead;

  return {
    believed: playhead.believed,
    jump: {
      first: jump.first,
      last: { positionMs: jump.last.positionMs, atMs },
      playableMs: playableTo(jump, atMs, rate),
    },
  };
};

/**
 * How much media the player has played on from the jump it made on its own to `positionMs` at
 * `atMs`; 0 when it made none, or did not play on from it. It counts no more than the time played
 * since the jump at the rates it played at: a skip through a vanished stream moves the position
 * without playing.
 */
export const playedOnFromJumpMs = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): number => {
  const jump = extendedJump(playhead, { positionMs, atMs }, rate);

  return jump !== null && playsOn(jump)
    ? Math.min(jump.last.positionMs - jump.first.positionMs, jump.playableMs)
    : 0;
};

/**
 * The position to report for a live reading of `positionMs` at `atMs`: the reading when playing
 * could have reached it, else the believed position.
 */
export const believedPosition = (
  playhead: Playhead,
  positionMs: number,
  atMs: number,
  rate: number,
): number =>
  believes(playhead, positionMs, atMs, rate) ? positionMs : playhead.believed.positionMs;
