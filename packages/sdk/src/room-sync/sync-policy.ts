import type { ClockAnchor } from "@media/contracts/clock";
import { DRIFT_THRESHOLDS, HEARTBEAT_INTERVAL_MS, targetPosition } from "@media/contracts/clock";
import type { EpochMillis } from "@media/contracts/units";
import { Milliseconds } from "@media/contracts/units";
import { Data, Option } from "effect";

/**
 * Tuning parameters for room synchronization. The defaults are starting points from the
 * architecture's playback spike; measure drift and recovery before changing them.
 */
export interface RoomSyncTunables {
  /** Within this distance a follower is in sync and runs at the room's rate. */
  readonly inSyncMs: number;
  /**
   * A nudging follower, or one whose clock just changed, corrects until it is this close, so it
   * settles near the shared position rather than anywhere inside `inSyncMs`.
   */
  readonly settleMs: number;
  /** Beyond this distance a follower seeks; between the two it nudges its rate. */
  readonly seekMs: number;
  /**
   * Beyond this distance a follower that cannot change its rate (a cast device) seeks; nudging
   * would do nothing, and seeks there are slow, so it tolerates more than `inSyncMs`.
   */
  readonly fixedRateSeekMs: number;
  /** How far from the room's rate a nudging follower runs, as a fraction. */
  readonly nudgeRate: number;
  /** How often a follower measures drift between clock changes. */
  readonly correctionIntervalMs: number;
  /** After a seek a follower only nudges for this long, so slow seeks do not loop. */
  readonly seekCooldownMs: number;
  /** A host seek further than this from the shared position becomes a room seek. */
  readonly hostSeekMs: number;
  /**
   * The longest a starting host follows the room to catch up with it before publishing its own
   * state again, for a stream that cannot keep up.
   */
  readonly hostCatchUpMs: number;
  /** How often members report presence; the host also reports its position. */
  readonly heartbeatIntervalMs: number;
  /** A heartbeat unanswered this long marks the connection lost and disables host controls. */
  readonly heartbeatTimeoutMs: number;
  /** Server clock readings per offset estimate; the one with the shortest round trip wins. */
  readonly offsetSamples: number;
  /** Pause between the readings of one estimate. */
  readonly offsetSampleSpacingMs: number;
  /** How often the offset is estimated again, to follow clock drift and better routes. */
  readonly offsetRefreshIntervalMs: number;
  /** Wait before reopening a failed room subscription. */
  readonly resubscribeDelayMs: number;
}

/** The default tunables, using the contracts' drift thresholds and heartbeat cadence. */
export const DEFAULT_TUNABLES: RoomSyncTunables = {
  inSyncMs: DRIFT_THRESHOLDS.inSyncMs,
  settleMs: 30,
  seekMs: DRIFT_THRESHOLDS.seekMs,
  fixedRateSeekMs: 750,
  nudgeRate: DRIFT_THRESHOLDS.nudgeRate,
  correctionIntervalMs: 500,
  seekCooldownMs: 3_000,
  hostSeekMs: 1_000,
  hostCatchUpMs: 15_000,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: 4_000,
  offsetSamples: 5,
  offsetSampleSpacingMs: 50,
  offsetRefreshIntervalMs: 30_000,
  resubscribeDelayMs: 1_000,
};

/** What a player reports at one instant. */
export interface PlayerSnapshot {
  readonly positionMs: number;
  readonly paused: boolean;
  /** Stalled waiting for data while meant to play. */
  readonly buffering: boolean;
  readonly playbackRate: number;
  /** The player cannot change its rate (`PlayerPort.fixedRate`). */
  readonly fixedRate: boolean;
}

/** One change to make to a player. */
export type PlayerCommand = Data.TaggedEnum<{
  Seek: { readonly positionMs: Milliseconds };
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

const rateDiffers = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6;

const holdAt = (
  player: PlayerSnapshot,
  positionMs: Milliseconds,
  clock: ClockAnchor,
  settling: boolean,
  tunables: RoomSyncTunables,
): FollowDecision => {
  const driftMs = player.positionMs - positionMs;

  const commands = [
    ...(player.paused ? [] : [PlayerCommand.Pause()]),
    ...(Math.abs(driftMs) > tunables.inSyncMs ? [PlayerCommand.Seek({ positionMs })] : []),
    ...(!player.fixedRate && rateDiffers(player.playbackRate, clock.playbackRate)
      ? [PlayerCommand.SetRate({ rate: clock.playbackRate })]
      : []),
  ];

  return { commands, driftMs, settling };
};

/**
 * Brings a following player toward the committed clock at `serverNow`. A stopped room holds the
 * player at the anchor. A playing room leaves a buffering player alone, seeks when far off
 * (unless a seek just happened), nudges the rate when moderately off, and runs at the room's rate
 * when in sync; a paused player also starts playing.
 *
 * In sync means within `inSyncMs`, so jitter does not keep changing the rate. A nudge, though, runs
 * until the player is within `settleMs` or passes the shared position. A `settling` follower faces
 * a fresh target (its clock just changed, or it just sought): it drops whatever nudge was running,
 * which may now lead away from the target, and nudges from `settleMs` on. Either way the player
 * ends near the shared position instead of anywhere in the band.
 */
export const follow = (
  clock: ClockAnchor,
  serverNow: EpochMillis,
  player: PlayerSnapshot,
  recentlySought: boolean,
  settling: boolean,
  tunables: RoomSyncTunables,
): FollowDecision => {
  const target = targetPosition(clock, serverNow);

  if (clock.status !== "playing") return holdAt(player, target, clock, settling, tunables);

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

/** A room command a host player's state calls for. */
export interface HostCommand {
  readonly command: "rooms.play" | "rooms.pause" | "rooms.seek" | "rooms.buffering";
  readonly positionMs: Milliseconds;
}

/**
 * Compares the host's player with the committed clock and names the command that would make the
 * room match it, or none. Comparing state rather than replaying player events means the engine's
 * own corrections, which leave the player matching the clock, never echo back as commands. A seek
 * counts only after a `seeked` event and only when it moved further than `hostSeekMs`.
 */
export const hostIntent = (
  clock: ClockAnchor,
  serverNow: EpochMillis,
  player: PlayerSnapshot,
  seeked: boolean,
  tunables: RoomSyncTunables,
): Option.Option<HostCommand> => {
  if (clock.status === "ended") return Option.none();
  const positionMs = Milliseconds.make(Math.max(0, player.positionMs));
  const at = (command: HostCommand["command"]) => Option.some<HostCommand>({ command, positionMs });

  const moved =
    Math.abs(player.positionMs - targetPosition(clock, serverNow)) > tunables.hostSeekMs;

  const seek = seeked && moved ? at("rooms.seek") : Option.none();

  if (!player.paused && player.buffering) {
    return clock.status === "playing" ? at("rooms.buffering") : Option.none();
  }

  if (!player.paused) return clock.status === "playing" ? seek : at("rooms.play");

  return clock.status === "playing" || clock.status === "buffering" ? at("rooms.pause") : seek;
};

/** A short name for a player command, for logs. */
export const commandLabel: (command: PlayerCommand) => string = PlayerCommand.$match({
  Seek: () => "seek",
  Play: () => "play",
  Pause: () => "pause",
  SetRate: () => "rate",
});
