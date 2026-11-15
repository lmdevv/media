/**
 * Follows a group session's clock with one player (ADR 0017). Every member runs one, the host
 * included: the core's clock is the only truth, and only a member's control moves it.
 */
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  Match,
  MutableRef,
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
import {
  FOLLOWER_TUNABLES,
  PlayerCommand,
  commandLabel,
  eventAction,
  expectedAfter,
  expectedAtLoad,
  expectedInPlace,
  expectedLanded,
  follow,
  hear,
  holdStands,
} from "./follower-policy";
import type {
  EventAction,
  EventOrigin,
  FollowerPlayerEvent,
  FollowerTunables,
  PlayerReading,
} from "./follower-policy";
import { EpochMillis } from "./units";

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

/**
 * A move of the clock, as `core.together.control` takes it. A play or a pause the follower makes on
 * its own, for a stalled player's hold, carries the revision it decided against: the core applies
 * it only while the session is still at it (ADR 0017). A viewer's carries none, so it always does.
 */
export type ClockMove =
  | { readonly kind: "play"; readonly revision?: number }
  | { readonly kind: "pause"; readonly revision?: number }
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
 * the clock it left, or null when the pause failed or someone else's move came first. `held`: the
 * session is paused at `revision`, the hold's own last move, and plays on once the player recovers,
 * while nothing newer has moved it (`holdStands`).
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
   * the play. A settled hold that no longer stands at `clock` is dropped.
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

/** How close to its end a player counts as having reached it. */
const END_SLACK_MS = 500;

/** A player event, with who caused it, as the follower judged it when it arrived. */
interface Heard {
  readonly event: FollowerPlayerEvent;
  readonly origin: EventOrigin;
  /**
   * The number of the follower's latest command when the event arrived. A command given after it
   * makes the event stale by the time the follower handles it.
   */
  readonly command: number;
}

/** The clock move a viewer's move asks for, against the clock at `revision`. */
const asMove = (move: ViewerMove, revision: number): ClockMove =>
  move.kind === "seek" ? { kind: "seek", positionMs: move.positionMs, revision } : move;

/**
 * A carried hold as a new follower takes it over at `clock`: a settled one that no longer stands
 * is none, as someone moved the session while the follower was being replaced.
 */
const takenOver = (hold: Hold | null, clock: SessionClock): Hold | null =>
  hold?.kind === "held" && !holdStands(hold.revision, clock) ? null : hold;

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
  // Read and written synchronously: the player's listener judges each event against it on arrival.
  const expected = MutableRef.make(expectedAtLoad(player.isPaused()));
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
    holding: takenOver(options.resumeHold ?? null, options.clock),
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

  /**
   * Numbers `command` and records the state it leaves the player in, before the player is called,
   * so every event the call makes the player report is judged against it.
   */
  const order = (command: PlayerCommand): void => {
    MutableRef.update(expected, (current) => expectedAfter(current, command));
  };

  const startPlaying = Effect.gen(function* () {
    if (!player.isPaused() && !MutableRef.get(expected).paused) return;

    order(PlayerCommand.Play());

    const started = yield* Effect.promise(() =>
      player.play().then(
        () => true,
        () => false,
      ),
    );

    if (started) return;

    // The platform refused to start playback: the player stays paused, with nothing on its way.
    MutableRef.update(expected, (current) => expectedInPlace(current, true));
    yield* Effect.logInfo("Follower.playBlocked");
    yield* update((current) => ({ ...current, follow: "blocked" }));
  });

  /** Gives the player `command`; a pause or play it already carries out gives nothing. */
  const execute = (command: PlayerCommand): Effect.Effect<void> =>
    PlayerCommand.$match(command, {
      Seek: ({ positionMs }) =>
        Effect.gen(function* () {
          yield* Ref.set(lastSeekAt, Option.some(yield* Clock.currentTimeMillis));
          order(command);
          player.seek(positionMs);
        }),
      Pause: () =>
        Effect.sync(() => {
          if (player.isPaused() && MutableRef.get(expected).paused) return;

          order(command);
          player.pause();
        }),
      SetRate: ({ rate }) => Effect.sync(() => player.setPlaybackRate(rate)),
      Play: () => startPlaying,
    });

  const align = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const now = yield* serverNow;

    if (Option.isNone(now)) return;

    const playerNow = reading();
    const sought = yield* recentlySought;

    const decision = follow(
      {
        clock: current.clock,
        serverNow: now.value,
        player: playerNow,
        recentlySought: sought,
        settling: (yield* Ref.get(settledOn)) !== current.clock.revision,
        durationMs: durationMs(),
      },
      tunables,
    );

    yield* Ref.set(settledOn, decision.settling ? null : current.clock.revision);
    yield* update((latest) => ({ ...latest, driftMs: decision.driftMs }));

    // A player that stands where the clock wants it carried out what it was given. A seek waits
    // for its `seeked` through the seek cooldown, since a slow one may land elsewhere.
    if (decision.commands.every(PlayerCommand.$is("SetRate"))) {
      MutableRef.update(expected, (latest) => {
        const placed = expectedInPlace(latest, playerNow.paused);

        return sought ? placed : expectedLanded(placed);
      });
    }

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
   * Takes `clock` when it is newer, ending a settled hold that no longer stands. A hold still
   * pausing has no revision yet; `settleHold` decides it once its pause lands.
   */
  const applyClock = (clock: SessionClock): Effect.Effect<boolean> =>
    SubscriptionRef.modify(state, (current) => {
      if (!isNewerRevision(clock, current.clock)) return [false, current];

      const overtaken =
        current.holding?.kind === "held" && !holdStands(current.holding.revision, clock);

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
   * failed seek still leaves it paused. The core applies the pause only while the session is still
   * at `seen`, the clock the player stalled on, so it never pauses a session someone else moved
   * since, a pause included; then it answers null and takes no hold. The seek applies only at the
   * pause's own revision. It sends only, so it can outlive the follower that asked.
   */
  const pauseAt = (standing: number, seen: number): Effect.Effect<SessionClock | null> =>
    Effect.gen(function* () {
      const paused = yield* Effect.option(port.control({ kind: "pause", revision: seen }));

      if (Option.isNone(paused)) return null;

      const sought = yield* Effect.option(
        port.control({ kind: "seek", positionMs: standing, revision: paused.value.revision }),
      );

      return Option.getOrElse(sought, () => paused.value);
    });

  /**
   * Takes over a hold whose pause is on the way: once it lands, the session is held at the clock
   * it left, and plays on when this player recovers. A pause the core refused or that failed, or a
   * clock newer than the one it left, leaves no hold.
   */
  const settleHold = (landed: Effect.Effect<SessionClock | null>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const clock = yield* landed;

      if (clock !== null) yield* applyClock(clock);

      const held = yield* SubscriptionRef.modify(state, (current) => {
        if (current.holding?.kind !== "pausing") return [false, current];

        const holding: Hold | null =
          clock !== null && holdStands(clock.revision, current.clock)
            ? { kind: "held", revision: clock.revision }
            : null;

        return [holding !== null, { ...current, holding }];
      });

      if (!held || clock === null) {
        yield* correct;

        return;
      }

      yield* Effect.logInfo("Follower.heldForStall").pipe(
        Effect.annotateLogs({ revision: clock.revision, positionMs: clock.positionAtAnchorMs }),
      );

      // The player may have recovered while the pause was on its way, with no event left to come.
      yield* releaseIfRecovered;
    });

  /**
   * Pauses the session where this stalled player stands, holding it until the player plays; `seen`
   * is the revision of the clock it stalled on. The requests run detached: a follower replaced
   * while they are on the way, as on a stream reload, hands the hold to the next one through
   * `resumeHold`.
   */
  const holdForStall = (seen: number): Effect.Effect<void> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const request = yield* Effect.forkDetach(pauseAt(player.positionMs(), seen));
        const landed = Fiber.join(request);

        // Sent and recorded together, so no stop in between loses a pause on its way.
        yield* update((current) => ({ ...current, holding: { kind: "pausing", landed } }));
        yield* restore(settleHold(landed));
      }),
    );

  /**
   * Plays the session on after this player's stall while the hold stands. The core applies the play
   * only while the session is still at the hold's own last revision, so a move this follower has
   * not heard of yet, such as the host's pause on another screen, always wins. The hold lasts until
   * a newer clock ends it in `applyClock`, the play's own answer included, so a play that fails,
   * refused or lost, leaves it for the next correction tick to try again.
   */
  const releaseHold = Effect.gen(function* () {
    const { clock, holding } = yield* SubscriptionRef.get(state);

    if (holding?.kind !== "held" || !holdStands(holding.revision, clock)) {
      yield* update((current) => ({ ...current, holding: null }));
      yield* correct;

      return;
    }

    yield* send({ kind: "play", revision: holding.revision }).pipe(Effect.ignore);
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
          yield* holdForStall(clock.revision);
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

  /** Whether the player is further than `viewerSeekMs` from the shared position. */
  const offClock = Effect.gen(function* () {
    const now = yield* serverNow;
    const { clock } = yield* SubscriptionRef.get(state);

    return Option.match(now, {
      onNone: () => false,
      onSome: (at) => Math.abs(player.positionMs() - positionAt(clock, at)) > tunables.viewerSeekMs,
    });
  });

  /** Carries out what `eventAction` decided about an event. */
  const act = (action: EventAction): Effect.Effect<void> =>
    Match.value(action).pipe(
      Match.whenOr("play", "pause", (kind) => moveSession({ kind }).pipe(Effect.ignore)),
      Match.when("seek", () =>
        moveSession({ kind: "seek", positionMs: player.positionMs() }).pipe(Effect.ignore),
      ),
      Match.when("detach", () => update((latest) => ({ ...latest, follow: "detached" }))),
      Match.when("follow", () => correct),
      Match.when("nothing", () => Effect.void),
      Match.exhaustive,
    );

  /**
   * Decides an event as the follower handles it, the one place and the one time an event can move
   * the session: `eventAction` reads who `hear` judged caused it on arrival, whether the follower
   * gave its player a command since, which makes it stale, and the session and the player as they
   * stand now. A `playing` from a stalled player that holds the session plays the hold on instead,
   * as a correction tick would.
   */
  const onEvent = (heard: Heard): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (heard.event === "waiting" || heard.event === "playing") yield* observe;

      const current = yield* SubscriptionRef.get(state);

      if (heard.event === "playing" && current.holding?.kind === "held") {
        if (recovered()) yield* releaseHold;

        return;
      }

      const latest = MutableRef.get(expected).command;
      const superseded = latest !== heard.command;

      if (heard.origin === "catching-up" || (superseded && heard.origin === "change")) {
        yield* Effect.logDebug("Follower.eventIgnored").pipe(
          Effect.annotateLogs({
            event: heard.event,
            origin: heard.origin,
            heardAt: heard.command,
            command: latest,
          }),
        );
      }

      yield* act(
        eventAction({
          event: heard.event,
          origin: heard.origin,
          superseded,
          controls: yield* Ref.get(controls),
          clock: current.clock.status,
          holding: current.holding !== null,
          paused: player.isPaused(),
          buffering: player.isBuffering(),
          atEnd: atEnd(),
          offClock: yield* offClock,
        }),
      );
    });

  const events = yield* Queue.unbounded<Heard>();

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      player.subscribe((event) => {
        // Matched on arrival against the commands given so far, in the order the player reports
        // them, so each echo carries out its own command; `onEvent` decides it when handled.
        const [origin, next] = hear(MutableRef.get(expected), event);

        MutableRef.set(expected, next);
        Queue.offerUnsafe(events, { event, origin, command: next.command });
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

  yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(events), onEvent)));
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
