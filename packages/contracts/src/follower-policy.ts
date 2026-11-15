/**
 * What a player following a group session's clock should do at one instant. Pure: the follower
 * engine (`./follower`) reads the player and the clock, asks `follow`, and carries out the answer.
 */
import { Data } from "effect";

import { DRIFT_THRESHOLDS, positionAt } from "./clock";
import type { SessionClock } from "./clock";
import type { EpochMillis } from "./units";

/**
 * Tuning for a following player. The defaults come from movies' rooms, measured on their playback
 * spike; measure drift and recovery before changing them.
 */
export interface FollowerTunables {
  /** Within this distance a follower is in sync and runs at the session's rate. */
  readonly inSyncMs: number;
  /**
   * A nudging follower, or one whose clock just changed, corrects until it is this close, so it
   * settles near the shared position rather than anywhere inside `inSyncMs`.
   */
  readonly settleMs: number;
  /** Beyond this distance a follower seeks; between the two it nudges its rate. */
  readonly seekMs: number;
  /**
   * Beyond this distance a follower that cannot change its rate seeks; nudging would do nothing,
   * and seeks there are slow, so it tolerates more than `inSyncMs`.
   */
  readonly fixedRateSeekMs: number;
  /** How far from the session's rate a nudging follower runs, as a fraction. */
  readonly nudgeRate: number;
  /** How often a follower measures drift between clock changes. */
  readonly correctionIntervalMs: number;
  /** After a seek a follower only nudges for this long, so slow seeks do not loop. */
  readonly seekCooldownMs: number;
  /**
   * A seek the viewer made, not the follower, counts only when it moved the player further than
   * this from the shared position; a stream reloading in place lands close to it.
   */
  readonly viewerSeekMs: number;
  /** How long a stall lasts before the player that pauses for stalls pauses the session. */
  readonly stallPauseMs: number;
}

/** The default tunables, with the contracts' drift thresholds. */
export const FOLLOWER_TUNABLES: FollowerTunables = {
  inSyncMs: DRIFT_THRESHOLDS.inSyncMs,
  settleMs: 30,
  seekMs: DRIFT_THRESHOLDS.seekMs,
  fixedRateSeekMs: 750,
  nudgeRate: DRIFT_THRESHOLDS.nudgeRate,
  correctionIntervalMs: 500,
  seekCooldownMs: 3_000,
  viewerSeekMs: 1_000,
  stallPauseMs: 1_000,
};

/** What a player reports at one instant. */
export interface PlayerReading {
  readonly positionMs: number;
  readonly paused: boolean;
  /** Stalled waiting for data while meant to play. */
  readonly buffering: boolean;
  readonly playbackRate: number;
  /** The player cannot change its rate, as a cast device cannot. */
  readonly fixedRate: boolean;
}

/** One change to make to a player. */
export type PlayerCommand = Data.TaggedEnum<{
  Seek: { readonly positionMs: number };
  Play: {};
  Pause: {};
  SetRate: { readonly rate: number };
}>;

/** Constructors and matchers for `PlayerCommand`. */
export const PlayerCommand = Data.taggedEnum<PlayerCommand>();

/** What a follower should do now, and how far off it was. */
export interface FollowDecision {
  readonly commands: ReadonlyArray<PlayerCommand>;
  /** Player position minus the shared position; positive means ahead. Null while buffering. */
  readonly driftMs: number | null;
  /**
   * Whether the next decision still faces a fresh target, as after a seek; pass it to the next
   * `follow`. A decision that starts a nudge clears it, as does one that finds the player in place
   * and already playing past the seek cooldown.
   */
  readonly settling: boolean;
}

/** What `follow` reads besides the clock and the player. */
export interface FollowInput {
  readonly clock: SessionClock;
  readonly serverNow: EpochMillis;
  readonly player: PlayerReading;
  /** The follower sought within `seekCooldownMs`. */
  readonly recentlySought: boolean;
  /** The follower faces a fresh target: its clock just changed, or it just sought. */
  readonly settling: boolean;
  /**
   * The length of the media the player plays, or null when unknown. The shared position past it
   * holds the player at its end: members' versions of an item can differ in length.
   */
  readonly durationMs: number | null;
}

/** How close to its end a player counts as having reached it. */
const END_SLACK_MS = 500;

const rateDiffers = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6;

const holdAt = (
  player: PlayerReading,
  positionMs: number,
  clock: SessionClock,
  settling: boolean,
  tunables: FollowerTunables,
): FollowDecision => {
  const driftMs = player.positionMs - positionMs;

  const commands = [
    ...(player.paused ? [] : [PlayerCommand.Pause()]),
    ...(Math.abs(driftMs) > (player.fixedRate ? tunables.fixedRateSeekMs : tunables.inSyncMs)
      ? [PlayerCommand.Seek({ positionMs })]
      : []),
    ...(!player.fixedRate && rateDiffers(player.playbackRate, clock.playbackRate)
      ? [PlayerCommand.SetRate({ rate: clock.playbackRate })]
      : []),
  ];

  return { commands, driftMs, settling };
};

/**
 * Brings a following player toward the session's clock. A paused session holds the player at the
 * anchor. A playing session leaves a buffering player alone, seeks when far off (unless a seek
 * just happened), nudges the rate when moderately off, and runs at the session's rate when in
 * sync; a paused player also starts playing. Past the end of the player's media the player waits
 * at its end.
 *
 * In sync means within `inSyncMs`, so jitter does not keep changing the rate. A nudge, though, runs
 * until the player is within `settleMs` or passes the shared position. A `settling` follower faces
 * a fresh target: it drops whatever nudge was running, which may now lead away from the target,
 * and nudges from `settleMs` on. Either way the player ends near the shared position instead of
 * anywhere in the band.
 */
export const follow = (
  input: FollowInput,
  tunables: FollowerTunables = FOLLOWER_TUNABLES,
): FollowDecision => {
  const { clock, player, recentlySought, settling, durationMs } = input;
  const shared = positionAt(clock, input.serverNow);
  const endMs = durationMs !== null && durationMs > 0 ? durationMs : null;
  const target = endMs === null ? shared : Math.min(shared, endMs);

  if (clock.status !== "playing") return holdAt(player, target, clock, settling, tunables);

  if (endMs !== null && shared >= endMs - END_SLACK_MS) {
    const far = Math.abs(player.positionMs - endMs) > tunables.seekMs;

    return {
      commands: far && !recentlySought ? [PlayerCommand.Seek({ positionMs: endMs })] : [],
      driftMs: null,
      settling,
    };
  }

  if (player.buffering) return { commands: [], driftMs: null, settling };
  const driftMs = player.positionMs - target;
  const distance = Math.abs(driftMs);
  const play = player.paused ? [PlayerCommand.Play()] : [];
  const seekBeyond = player.fixedRate ? tunables.fixedRateSeekMs : tunables.seekMs;

  if (distance >= seekBeyond && !recentlySought) {
    const rate =
      !player.fixedRate && rateDiffers(player.playbackRate, clock.playbackRate)
        ? [PlayerCommand.SetRate({ rate: clock.playbackRate })]
        : [];

    return {
      commands: [PlayerCommand.Seek({ positionMs: target }), ...rate, ...play],
      driftMs,
      settling: true,
    };
  }

  if (player.fixedRate) return { commands: play, driftMs, settling };

  const nudging =
    !settling && rateDiffers(player.playbackRate, clock.playbackRate)
      ? Math.sign(player.playbackRate - clock.playbackRate)
      : 0;

  const closing =
    (nudging > 0 && driftMs < -tunables.settleMs) || (nudging < 0 && driftMs > tunables.settleMs);

  const correcting =
    nudging === 0
      ? distance > (settling ? tunables.settleMs : tunables.inSyncMs)
      : closing || distance > tunables.inSyncMs;

  const wanted = correcting
    ? clock.playbackRate * (1 + (driftMs > 0 ? -1 : 1) * tunables.nudgeRate)
    : clock.playbackRate;

  const rate = rateDiffers(player.playbackRate, wanted)
    ? [PlayerCommand.SetRate({ rate: wanted })]
    : [];

  const settled = correcting || (!player.paused && !recentlySought);

  return { commands: [...rate, ...play], driftMs, settling: settling && !settled };
};

/** A short name for a player command, for logs. */
export const commandLabel: (command: PlayerCommand) => string = PlayerCommand.$match({
  Seek: () => "seek",
  Play: () => "play",
  Pause: () => "pause",
  SetRate: () => "rate",
});
