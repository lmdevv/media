/**
 * Follows a group session's clock with one player (ADR 0017). Every member runs one, the host
 * included: the core's clock is the only truth, and only a member's control moves it.
 */
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Schedule,
  Semaphore,
  SubscriptionRef,
} from "effect";
import type { Scope, Stream } from "effect";

import {
  CLOCK_SAMPLING,
  estimateClockOffset,
  isNewerRevision,
  positionAt,
  toServerTime,
} from "./clock";
import type { ClockOffset, ClockSample, SessionClock } from "./clock";
import { FOLLOWER_TUNABLES, PlayerCommand, commandLabel, follow } from "./follower-policy";
import type { FollowerTunables, PlayerReading } from "./follower-policy";
import { EpochMillis } from "./units";

/** Something that happened on a player, from the viewer, the network, or the follower itself. */
export type FollowerPlayerEvent = "playing" | "paused" | "seeked" | "waiting" | "ended";

/**
 * A media player as the follower drives it. Getters return the state at the moment of the call;
 * `subscribe` reports events as they happen and returns a function that stops reporting. The
 * SDK's `PlayerPort` is one.
 */
export interface FollowerPlayer {
  /** Position in the media, in milliseconds. */
  readonly positionMs: () => number;
  readonly isPaused: () => boolean;
  /** Stalled waiting for data while meant to be playing. */
  readonly isBuffering: () => boolean;
  readonly playbackRate: () => number;
  readonly setPlaybackRate: (rate: number) => void;
  readonly seek: (positionMs: number) => void;
  /** Starts playback. Rejects when the platform blocks playback until the user interacts. */
  readonly play: () => Promise<void>;
  readonly pause: () => void;
  readonly subscribe: (listener: (event: FollowerPlayerEvent) => void) => () => void;
  /** The player plays at normal speed only: the follower corrects drift by seeking. */
  readonly fixedRate?: boolean;
}

/** A move of the clock, as `core.together.control` takes it. */
export type ClockMove =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  /** A seek means something only against the clock the member saw, so it carries its revision. */
  | { readonly kind: "seek"; readonly positionMs: number; readonly revision: number };

/** A viewer's play, pause, or seek through the player's controls. */
export type ViewerMove =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "seek"; readonly positionMs: number };

/**
 * The session as the follower reaches it.
 *
 * @template E - What a call fails with; the follower recovers from every failure but a viewer's
 *   move, which it hands back to the caller.
 */
export interface SessionPort<E> {
  /** `core.together.heartbeat`: keeps the member present and answers the server's time. */
  readonly heartbeat: Effect.Effect<{ readonly serverTime: number }, E>;
  /** `core.together.control`: moves the clock and answers the clock in force. */
  readonly control: (move: ClockMove) => Effect.Effect<SessionClock, E>;
}

/**
 * How the player follows. `buffering`: stalled, catching up when it plays again. `detached`: a
 * viewer who may not control paused their own player; following resumes when they play.
 * `blocked`: the platform refused to start playback until the viewer interacts.
 */
export type FollowState = "following" | "buffering" | "detached" | "blocked";

/** Where the follower stands, for the screen. */
export interface FollowerState {
  /** The newest clock applied. */
  readonly clock: SessionClock;
  readonly follow: FollowState;
  /** Server time minus device time, once estimated. */
  readonly offset: ClockOffset | null;
  /** The last measured distance from the shared position; positive means ahead. */
  readonly driftMs: number | null;
  /** The session this player paused for its stall, or null without a hold. */
  readonly holding: Hold | null;
}

/**
 * A stalled player's hold on the session. `pausing`: its pause is on the way, and `landed` answers
 * the clock it left, or null when the pause failed. `held`: the session is paused at `revision`,
 * and plays on once the player recovers, unless the clock moved past it.
 */
export type Hold =
  | { readonly kind: "pausing"; readonly landed: Effect.Effect<SessionClock | null> }
  | { readonly kind: "held"; readonly revision: number };

/** What to follow, with what. */
export interface FollowerOptions<E> {
  readonly player: FollowerPlayer;
  readonly port: SessionPort<E>;
  /** The session's clock when following starts. */
  readonly clock: SessionClock;
  /** The length of the player's media now, or null while unknown; read at each correction. */
  readonly durationMs: () => number | null;
  /**
   * Whether the viewer may control the session. Their own moves on the player, such as a pause
   * from picture in picture, then move the session; otherwise the player returns to the clock.
   */
  readonly controls: boolean;
  /** Whether this player pauses the session while it stalls, as its host's does. */
  readonly pausesForStalls: boolean;
  /**
   * The hold an earlier follower of this player left, such as one stopped while its stream
   * reloaded: this one plays the session on once the player plays. A pause still on its way counts:
   * the request goes on without its follower, so whichever follower holds it when it lands owns
   * the play.
   */
  readonly resumeHold?: Hold | null;
  readonly tunables?: FollowerTunables;
}

/** A running follower. It stops when its scope closes. */
export interface Follower<E> {
  /** The current state, then every change. */
  readonly state: Stream.Stream<FollowerState>;
  /** The state now. */
  readonly current: Effect.Effect<FollowerState>;
  /** Applies a clock the session's subscription delivered; an older revision changes nothing. */
  readonly apply: (clock: SessionClock) => Effect.Effect<void>;
  /** Says whether the viewer may control the session now, as the host's switch changes. */
  readonly allow: (controls: boolean) => Effect.Effect<void>;
  /**
   * Carries out the viewer's move at once on the player and asks the session for it. A refused
   * move fails with the session's error, and the player returns to the clock.
   */
  readonly move: (move: ViewerMove) => Effect.Effect<void, E>;
}

/** A seek the follower made lands within this of its target, or counts as the viewer's. */
const SEEK_ECHO_MS = 1_000;

/** How close to its end a player counts as having reached it. */
const END_SLACK_MS = 500;

/** A player event, with the revision of the clock applied when the follower heard it. */
interface Heard {
  readonly event: FollowerPlayerEvent;
  readonly revision: number;
}

/** The clock move a viewer's move asks for, against the clock at `revision`. */
const asMove = (move: ViewerMove, revision: number): ClockMove =>
  move.kind === "seek" ? { kind: "seek", positionMs: move.positionMs, revision } : move;

/** Takes one echo off `echoes`, saying whether there was one to take. */
const isEcho = (echoes: Ref.Ref<number>): Effect.Effect<boolean> =>
  Ref.modify(echoes, (count) => (count > 0 ? [true, count - 1] : [false, 0]));

/**
 * Starts following `options.clock` with `options.player`. Samples the server's clock first, so a
 * late joiner seeks straight to the live position.
 */
export const run = Effect.fn("Follower.run")(function* <E>(
  options: FollowerOptions<E>,
): Effect.fn.Return<Follower<E>, never, Scope.Scope> {
  const { player, port, durationMs, pausesForStalls } = options;
  const tunables = options.tunables ?? FOLLOWER_TUNABLES;
  const samples = yield* Ref.make<ReadonlyArray<ClockSample>>([]);
  const lastSeekAt = yield* Ref.make(Option.none<number>());
  const settledOn = yield* Ref.make<number | null>(null);
  const pauseEchoes = yield* Ref.make(0);
  const playEchoes = yield* Ref.make(0);
  const seekEchoes = yield* Ref.make<ReadonlyArray<number>>([]);
  const controls = yield* Ref.make(options.controls);
  const moving = yield* Ref.make(0);
  const stallWatch = yield* Ref.make(Option.none<Fiber.Fiber<void>>());
  const serial = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;

  const state = yield* SubscriptionRef.make<FollowerState>({
    clock: options.clock,
    follow: "following",
    offset: null,
    driftMs: null,
    holding: options.resumeHold ?? null,
  });

  const update = (change: (current: FollowerState) => FollowerState): Effect.Effect<void> =>
    SubscriptionRef.update(state, change);

  const sample = Effect.gen(function* () {
    const sentAt = yield* Clock.currentTimeMillis;
    const { serverTime } = yield* port.heartbeat;
    const receivedAt = yield* Clock.currentTimeMillis;

    return { sentAt, serverTime: EpochMillis.make(Math.round(serverTime)), receivedAt };
  });

  const addSamples = Effect.gen(function* () {
    const fresh = yield* Effect.forEach(
      Array.from({ length: CLOCK_SAMPLING.burst }, (_, index) => index),
      (index) =>
        Effect.option(sample).pipe(
          Effect.delay(Duration.millis(index === 0 ? 0 : CLOCK_SAMPLING.spacingMs)),
        ),
    );

    const kept = yield* Ref.updateAndGet(samples, (old) =>
      [...old, ...fresh.flatMap(Option.toArray)].slice(-CLOCK_SAMPLING.kept),
    );

    const offset = estimateClockOffset(kept) ?? null;

    if (offset !== null) yield* update((current) => ({ ...current, offset }));
  });

  const serverNow: Effect.Effect<Option.Option<EpochMillis>> = Effect.gen(function* () {
    const { offset } = yield* SubscriptionRef.get(state);

    if (offset === null) return Option.none();

    return Option.some(toServerTime(yield* Clock.currentTimeMillis, offset));
  });

  const reading = (): PlayerReading => ({
    positionMs: player.positionMs(),
    paused: player.isPaused(),
    buffering: player.isBuffering(),
    playbackRate: player.playbackRate(),
    fixedRate: player.fixedRate === true,
  });

  const recentlySought = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    return Option.match(yield* Ref.get(lastSeekAt), {
      onNone: () => false,
      onSome: (at) => now - at < tunables.seekCooldownMs,
    });
  });

  const startPlaying = Effect.gen(function* () {
    const echoes = player.isPaused();

    if (echoes) yield* Ref.update(playEchoes, (count) => count + 1);

    const started = yield* Effect.promise(() =>
      player.play().then(
        () => true,
        () => false,
      ),
    );

    if (started) return;

    if (echoes) yield* Ref.update(playEchoes, (count) => Math.max(0, count - 1));
    yield* Effect.logInfo("Follower.playBlocked");
    yield* update((current) => ({ ...current, follow: "blocked" }));
  });

  const execute = (command: PlayerCommand): Effect.Effect<void> =>
    PlayerCommand.$match(command, {
      Seek: ({ positionMs }) =>
        Effect.gen(function* () {
          yield* Ref.set(lastSeekAt, Option.some(yield* Clock.currentTimeMillis));
          yield* Ref.update(seekEchoes, (targets) => [...targets.slice(-4), positionMs]);
          player.seek(positionMs);
        }),
      Pause: () =>
        Effect.gen(function* () {
          if (player.isPaused()) return;
          yield* Ref.update(pauseEchoes, (count) => count + 1);
          player.pause();
        }),
      SetRate: ({ rate }) => Effect.sync(() => player.setPlaybackRate(rate)),
      Play: () => startPlaying,
    });

  const align = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const now = yield* serverNow;

    if (Option.isNone(now)) return;

    const decision = follow(
      {
        clock: current.clock,
        serverNow: now.value,
        player: reading(),
        recentlySought: yield* recentlySought,
        settling: (yield* Ref.get(settledOn)) !== current.clock.revision,
        durationMs: durationMs(),
      },
      tunables,
    );

    yield* Ref.set(settledOn, decision.settling ? null : current.clock.revision);
    yield* update((latest) => ({ ...latest, driftMs: decision.driftMs }));

    if (decision.commands.length > 0) {
      yield* Effect.logDebug("Follower.correct").pipe(
        Effect.annotateLogs({
          revision: current.clock.revision,
          driftMs: decision.driftMs ?? "none",
          commands: decision.commands.map(commandLabel).join(","),
        }),
      );
    }

    yield* Effect.forEach(decision.commands, execute, { discard: true });
  });

  const correct = serial.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);

      if ((yield* Ref.get(moving)) > 0 || current.holding !== null) return;

      if (current.follow === "detached" && current.clock.status === "playing") return;

      if (current.follow === "blocked") return;

      yield* align;
    }),
  );

  /**
   * Takes `clock` when it is newer, ending a hold that someone else's move overtook. A hold still
   * pausing has no revision yet, so its own answers never overtake it.
   */
  const applyClock = (clock: SessionClock): Effect.Effect<boolean> =>
    SubscriptionRef.modify(state, (current) => {
      if (!isNewerRevision(clock, current.clock)) return [false, current];

      const overtaken =
        current.holding?.kind === "held" && clock.revision > current.holding.revision;

      return [
        true,
        {
          ...current,
          clock,
          holding: overtaken ? null : current.holding,
          follow:
            current.follow === "detached" && clock.status !== "playing"
              ? "following"
              : current.follow,
        },
      ];
    });

  const apply = (clock: SessionClock): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (yield* applyClock(clock)) yield* correct;
    });

  /** Sends `move`, taking the clock it answers; corrections wait until it is answered. */
  const send = (move: ClockMove): Effect.Effect<SessionClock, E> =>
    Effect.acquireUseRelease(
      Ref.update(moving, (count) => count + 1),
      () => Effect.tap(port.control(move), applyClock),
      () => Ref.update(moving, (count) => count - 1),
    ).pipe(Effect.ensuring(correct));

  const moveSession = (move: ViewerMove): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      const { clock } = yield* SubscriptionRef.get(state);

      yield* send(asMove(move, clock.revision));
    });

  const viewerMove = (move: ViewerMove): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      yield* serial.withPermits(1)(
        move.kind === "play"
          ? Effect.andThen(
              update((current) => ({ ...current, follow: "following" })),
              startPlaying,
            )
          : execute(
              move.kind === "pause"
                ? PlayerCommand.Pause()
                : PlayerCommand.Seek({ positionMs: move.positionMs }),
            ),
      );
      yield* moveSession(move);
    });

  /**
   * Pauses the session at `standing`, then seeks it back there, answering the clock it leaves; a
   * failed seek still leaves it paused. It sends only, so it can outlive the follower that asked.
   */
  const pauseAt = (standing: number): Effect.Effect<SessionClock | null> =>
    Effect.gen(function* () {
      const paused = yield* Effect.option(port.control({ kind: "pause" }));

      if (Option.isNone(paused)) return null;

      const sought = yield* Effect.option(
        port.control({ kind: "seek", positionMs: standing, revision: paused.value.revision }),
      );

      return Option.getOrElse(sought, () => paused.value);
    });

  /**
   * Takes over a hold whose pause is on the way: once it lands, the session is held at the clock
   * it left, and plays on when this player recovers. A failed pause leaves no hold.
   */
  const settleHold = (landed: Effect.Effect<SessionClock | null>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const clock = yield* landed;

      if (clock === null) {
        yield* update((current) => ({
          ...current,
          holding: current.holding?.kind === "pausing" ? null : current.holding,
        }));
        yield* correct;

        return;
      }

      yield* applyClock(clock);
      yield* update((current) => ({
        ...current,
        holding:
          current.holding?.kind === "pausing"
            ? { kind: "held", revision: clock.revision }
            : current.holding,
      }));
      yield* Effect.logInfo("Follower.heldForStall").pipe(
        Effect.annotateLogs({ revision: clock.revision, positionMs: clock.positionAtAnchorMs }),
      );

      // The player may have recovered while the pause was on its way, with no event left to come.
      yield* releaseIfRecovered;
    });

  /**
   * Pauses the session where this stalled player stands, holding it until the player plays. The
   * requests run detached: a follower replaced while they are on the way, as on a stream reload,
   * hands the hold to the next one through `resumeHold`.
   */
  const holdForStall = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const request = yield* Effect.forkDetach(pauseAt(player.positionMs()));
      const landed = Fiber.join(request);

      // Sent and recorded together, so no stop in between loses a pause on its way.
      yield* update((current) => ({ ...current, holding: { kind: "pausing", landed } }));
      yield* restore(settleHold(landed));
    }),
  );

  /**
   * Plays the session on after this player's stall, unless someone moved it meanwhile. The hold
   * lasts until a newer clock ends it in `applyClock`, the play's own answer included, so a play
   * that fails leaves it for the next correction tick to try again.
   */
  const releaseHold = Effect.gen(function* () {
    const { clock, holding } = yield* SubscriptionRef.get(state);

    if (
      holding?.kind !== "held" ||
      clock.revision !== holding.revision ||
      clock.status !== "paused"
    ) {
      yield* update((current) => ({ ...current, holding: null }));
      yield* correct;

      return;
    }

    yield* send({ kind: "play" }).pipe(Effect.ignore);
  });

  /** Whether this player plays again after its stall. */
  const recovered = (): boolean => !player.isBuffering() && !player.isPaused();

  /** Ends a settled hold whose player already plays again, as a missed `playing` event would. */
  const releaseIfRecovered: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      const { holding } = yield* SubscriptionRef.get(state);

      if (holding?.kind === "held" && recovered()) yield* releaseHold;
    }),
  );

  const watchStall = Effect.gen(function* () {
    if (!pausesForStalls || Option.isSome(yield* Ref.get(stallWatch))) return;

    const { clock, holding } = yield* SubscriptionRef.get(state);

    if (holding !== null || clock.status !== "playing" || (yield* recentlySought)) return;

    if ((yield* Ref.get(moving)) > 0) return;

    const watch = yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(tunables.stallPauseMs));

        const latest = yield* SubscriptionRef.get(state);

        if (
          player.isBuffering() &&
          latest.holding === null &&
          latest.clock.revision === clock.revision &&
          latest.clock.status === "playing"
        ) {
          yield* holdForStall;
        }
      }).pipe(Effect.ensuring(Ref.set(stallWatch, Option.none()))),
      scope,
    );

    yield* Ref.set(stallWatch, Option.some(watch));
  });

  /**
   * Brings `follow` in line with the player as it is now, whatever event prompted it: a stalled
   * player buffers and is watched for a hold, and one that plays follows again.
   */
  const observe = Effect.gen(function* () {
    const buffering = player.isBuffering();
    const playing = !buffering && !player.isPaused();

    yield* SubscriptionRef.updateSome(state, (current) => {
      if (buffering && current.follow === "following") {
        return Option.some({ ...current, follow: "buffering" });
      }

      if (playing && current.follow !== "following") {
        return Option.some({ ...current, follow: "following" });
      }

      return Option.none();
    });

    if (buffering) yield* watchStall;
  });

  /**
   * A correction tick: a recovered hold plays on, anything else corrects the player. It reads the
   * player too, so a stall whose event was missed or came before the clock in force still counts.
   */
  const tick = Effect.gen(function* () {
    yield* observe;

    const { holding } = yield* SubscriptionRef.get(state);

    if (holding?.kind === "held" && recovered()) {
      yield* releaseHold;

      return;
    }

    yield* correct;
  });

  /** A media element pauses itself as it reaches its end, which is no one's move. */
  const atEnd = (): boolean => {
    const length = durationMs();

    return length !== null && length > 0 && player.positionMs() >= length - END_SLACK_MS;
  };

  const isSeekEcho = (landed: number): Effect.Effect<boolean> =>
    Ref.modify(seekEchoes, (targets) => {
      const at = targets.findIndex((target) => Math.abs(landed - target) <= SEEK_ECHO_MS);

      return at === -1 ? [false, targets] : [true, targets.slice(at + 1)];
    });

  /** Whether the player is further than `viewerSeekMs` from the shared position. */
  const offClock = Effect.gen(function* () {
    const now = yield* serverNow;
    const { clock } = yield* SubscriptionRef.get(state);

    return Option.match(now, {
      onNone: () => false,
      onSome: (at) => Math.abs(player.positionMs() - positionAt(clock, at)) > tunables.viewerSeekMs,
    });
  });

  const onPaused = (fresh: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (yield* isEcho(pauseEchoes)) return;

      if (!player.isPaused()) {
        yield* correct;

        return;
      }

      const current = yield* SubscriptionRef.get(state);

      if (current.clock.status !== "playing" || current.holding !== null || atEnd()) return;

      if (!(yield* Ref.get(controls))) {
        yield* update((latest) => ({ ...latest, follow: "detached" }));

        return;
      }

      if (fresh) {
        yield* moveSession({ kind: "pause" }).pipe(Effect.ignore);

        return;
      }

      yield* correct;
    });

  const onSeeked = (fresh: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      const echo = yield* isSeekEcho(player.positionMs());

      if (!echo && fresh && (yield* Ref.get(controls)) && (yield* offClock)) {
        yield* moveSession({ kind: "seek", positionMs: player.positionMs() }).pipe(Effect.ignore);

        return;
      }

      yield* correct;
    });

  const onPlaying = (fresh: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      const echo = yield* isEcho(playEchoes);
      const current = yield* SubscriptionRef.get(state);

      yield* observe;

      if (current.holding?.kind === "held") {
        if (recovered()) yield* releaseHold;

        return;
      }

      const viewerPlay = !echo && fresh && current.follow !== "buffering" && !player.isPaused();

      if ((yield* Ref.get(controls)) && viewerPlay && current.clock.status === "paused") {
        yield* moveSession({ kind: "play" }).pipe(Effect.ignore);

        return;
      }

      yield* correct;
    });

  /**
   * Each handler gets whether its event is fresh: heard while the clock in force was already
   * applied. Only a fresh event moves the session, and only while the player still stands where
   * the event says; anything else brings the player to the clock in force. Otherwise a `playing`
   * from before a pause, read against the paused clock, would play the session again.
   */
  const onEvent: Record<FollowerPlayerEvent, (fresh: boolean) => Effect.Effect<void>> = {
    waiting: () => observe,
    paused: onPaused,
    seeked: onSeeked,
    playing: onPlaying,
    ended: () => Effect.void,
  };

  const events = yield* Queue.unbounded<Heard>();

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      player.subscribe((event) => {
        Queue.offerUnsafe(events, {
          event,
          revision: SubscriptionRef.getUnsafe(state).clock.revision,
        });
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const { clock } = yield* SubscriptionRef.get(state);

      player.setPlaybackRate(clock.playbackRate);
    }),
  );

  yield* addSamples;
  yield* correct;

  if (options.resumeHold?.kind === "pausing") {
    yield* Effect.forkScoped(settleHold(options.resumeHold.landed));
  }

  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const heard = yield* Queue.take(events);
        const { clock } = yield* SubscriptionRef.get(state);

        yield* onEvent[heard.event](heard.revision === clock.revision);
      }),
    ),
  );
  yield* Effect.forkScoped(
    addSamples.pipe(Effect.delay(Duration.millis(CLOCK_SAMPLING.everyMs)), Effect.forever),
  );
  yield* Effect.forkScoped(
    tick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(tunables.correctionIntervalMs)))),
  );

  return {
    state: SubscriptionRef.changes(state),
    current: SubscriptionRef.get(state),
    apply,
    allow: (next) => Ref.set(controls, next),
    move: viewerMove,
  };
});
