/**
 * What a player following a group session's clock should do at one instant. Pure: the follower
 * engine (`./follower`) reads the player and the clock, asks `follow`, and carries out the answer.
 * It asks `hear` and `eventAction` whether a player event moves the session, and `holdStands`
 * whether a stalled player's hold may play it on.
 */
import { Data, Match } from "effect";

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

/** Something that happened on a player, from the viewer, the network, or the follower itself. */
export type FollowerPlayerEvent = "playing" | "paused" | "seeked" | "waiting" | "ended";

/**
 * A command the follower gave its player and waits to see carried out. `load` is the stream the
 * follower started on, which the playback that loaded it may still be starting or seeking.
 */
export type PendingCommand = "load" | "play" | "pause" | "seek";

/**
 * The state a follower expects its player in after its latest command (ADR 0017). Each play,
 * pause, and seek it gives the player, and the load it starts on, takes the next number.
 */
export interface Expected {
  /** The number of the latest command. */
  readonly command: number;
  /** Whether the player stands paused after the latest play or pause, or as it last reported. */
  readonly paused: boolean;
  /**
   * The commands the player has not yet shown carried out: the load, the latest play or pause, and
   * the latest seek. A play replaces a pending pause, and a pause a play.
   */
  readonly pending: ReadonlyArray<PendingCommand>;
}

/** What a follower expects of the player it starts on, `paused` or not: the load to settle. */
export const expectedAtLoad = (paused: boolean): Expected => ({
  command: 1,
  paused,
  pending: ["load"],
});

/** Whether `command` makes `other` pending no longer: a later play or pause, or a later seek. */
const replaces = (command: PendingCommand, other: PendingCommand): boolean =>
  command === "seek" ? other === "seek" : other === "play" || other === "pause";

/** The state after the next command, `command`, which leaves the player `paused` or not. */
const ordered = (expected: Expected, command: PendingCommand, paused: boolean): Expected => ({
  command: expected.command + 1,
  paused,
  pending: [...expected.pending.filter((other) => !replaces(command, other)), command],
});

/** The state after the follower gives `command`; a rate change shows in no event, so it is none. */
export const expectedAfter = (expected: Expected, command: PlayerCommand): Expected =>
  PlayerCommand.$match(command, {
    Play: () => ordered(expected, "play", false),
    Pause: () => ordered(expected, "pause", true),
    Seek: () => ordered(expected, "seek", expected.paused),
    SetRate: () => expected,
  });

/**
 * The player stands where the clock wants it, `paused` or not: the load and its play or pause are
 * carried out. A seek still waits for its `seeked`, which a slow one sends from wherever it landed.
 */
export const expectedInPlace = (expected: Expected, paused: boolean): Expected => ({
  ...expected,
  paused,
  pending: expected.pending.filter((command) => command === "seek"),
});

/** A seek whose `seeked` never came counts as landed, as once the seek cooldown passed. */
export const expectedLanded = (expected: Expected): Expected => ({
  ...expected,
  pending: expected.pending.filter((command) => command !== "seek"),
});

/**
 * Who caused a player event, judged as it arrives. `command`: it shows the player carried out the
 * pending command. `catching-up`: a command is pending, and this event does not show it carried
 * out. `change`: nothing was pending, and the player now stands otherwise than expected, by the
 * viewer's hand or its own. `unchanged`: nothing was pending, and nothing expected changed.
 */
export type EventOrigin = "command" | "catching-up" | "change" | "unchanged";

/** The event that shows each command carried out; a load shows in none. */
const CARRIED_OUT_BY: Readonly<Record<PendingCommand, FollowerPlayerEvent | null>> = {
  load: null,
  play: "playing",
  pause: "paused",
  seek: "seeked",
};

/**
 * Judges `event` as it arrives against what the follower expects of its player, and answers what it
 * expects afterwards. While a command is pending, an event is the player carrying one out or
 * catching up, so it never moves the session; a `seeked` carries out a pending seek wherever it
 * landed. With nothing pending, a play or pause that differs from the expected state is a change.
 * `eventAction` then decides, when the follower handles the event, what a change does (ADR 0017).
 */
export const hear = (
  expected: Expected,
  event: FollowerPlayerEvent,
): readonly [EventOrigin, Expected] => {
  if (expected.pending.length > 0) {
    const rest = expected.pending.filter((command) => CARRIED_OUT_BY[command] !== event);

    return rest.length < expected.pending.length
      ? ["command", { ...expected, pending: rest }]
      : ["catching-up", expected];
  }

  if (event === "seeked") return ["change", expected];

  if (event !== "playing" && event !== "paused") return ["unchanged", expected];

  const paused = event === "paused";

  return paused === expected.paused ? ["unchanged", expected] : ["change", { ...expected, paused }];
};

/**
 * What a follower does about a player event. `play`, `pause`, `seek`: moves the session as the
 * viewer's change asks, a seek to where the player stands. `detach`: stops following until the
 * viewer plays, as they may not control and paused their own player. `follow`: brings the player to
 * the clock. `nothing`: leaves it be, as a player that paused at its end.
 */
export type EventAction = "play" | "pause" | "seek" | "detach" | "follow" | "nothing";

/** What a follower knows when it handles a player event. */
export interface EventFacts {
  readonly event: FollowerPlayerEvent;
  /** Who caused the event, as `hear` judged it on arrival. */
  readonly origin: EventOrigin;
  /**
   * The follower gave its player a play, pause, or seek after the event arrived, as for a newer
   * clock: the event is stale, whoever caused it.
   */
  readonly superseded: boolean;
  /** Whether the viewer may control the session. */
  readonly controls: boolean;
  /** Whether the session plays or is paused. */
  readonly clock: SessionClock["status"];
  /** The player paused the session for its stall, or is pausing it. */
  readonly holding: boolean;
  /** The player is paused now. */
  readonly paused: boolean;
  /** The player is stalled now. */
  readonly buffering: boolean;
  /** The player stands at the end of its media, where it pauses itself. */
  readonly atEnd: boolean;
  /** The player stands further than `viewerSeekMs` from the shared position. */
  readonly offClock: boolean;
}

/**
 * Decides what a player event does as the follower handles it: the one rule for whether an event
 * moves the session (ADR 0017). Only a change moves it, only while no command followed it, only
 * while the player still stands where the event says, and only for a viewer who may control; every
 * other event brings the player back to the clock.
 */
export const eventAction = (facts: EventFacts): EventAction => {
  const change = facts.origin === "change" && !facts.superseded;

  return Match.value(facts.event).pipe(
    Match.whenOr("waiting", "ended", (): EventAction => "nothing"),
    Match.when("playing", (): EventAction =>
      change && facts.controls && facts.clock === "paused" && !facts.paused && !facts.buffering
        ? "play"
        : "follow",
    ),
    Match.when("paused", (): EventAction => {
      if (!change || !facts.paused) return "follow";

      if (facts.clock !== "playing" || facts.holding || facts.atEnd) return "nothing";

      return facts.controls ? "pause" : "detach";
    }),
    Match.when("seeked", (): EventAction =>
      change && facts.controls && facts.offClock ? "seek" : "follow",
    ),
    Match.exhaustive,
  );
};

/**
 * Whether a stalled player's hold may play the session on, judged against the newest clock the
 * follower has: the one rule for holds (ADR 0017). The hold's own last move, its pause or the seek
 * back to the stall, left the session paused at `heldRevision`. A clock at that revision is that
 * move's. An older one has yet to show it, as from a subscription that lags the move's answer, so
 * the hold stands and waits for it. Only a newer clock ends the hold: someone moved the session
 * since, or the hold's own play answered. The core gives every pause a new revision, so a pause
 * that changed nothing ends the hold too.
 */
export const holdStands = (heldRevision: number, clock: SessionClock): boolean =>
  clock.revision < heldRevision || (clock.revision === heldRevision && clock.status === "paused");
