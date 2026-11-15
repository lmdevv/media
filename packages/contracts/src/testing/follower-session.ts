/**
 * A group session for follower tests: its clock as the core keeps it, members who hear each new
 * clock one network latency after it moves, and time on Effect's test clock.
 */
import { Clock, Data, Effect, Fiber, Layer, Match, Ref } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";

import { positionAt } from "../clock";
import type { SessionClock } from "../clock";
import { run } from "../follower";
import type { ClockMove, Follower, FollowerPlayer, Hold, SessionPort } from "../follower";
import { EpochMillis } from "../units";

/** When every scenario starts, in device milliseconds. */
export const START = 1_760_000_000_000;

/** How far the server's clock runs ahead of the device's. */
export const SERVER_OFFSET_MS = 7_000;

/** Each way of every call to the session, and of every clock it delivers. */
export const LATENCY_MS = 40;

/** The session refused a call, as the core does for a member without control or a stale seek. */
export class Refused extends Data.TaggedError("Refused")<{ readonly reason: string }> {}

/** A session from `makeSession`, with the controls a test drives it by. */
export interface Session {
  /** The session's calls, as a follower makes them. */
  readonly port: SessionPort<Refused>;
  /** The clock in force. */
  readonly clock: Effect.Effect<SessionClock>;
  /** The shared position now, by the server's clock. */
  readonly shared: Effect.Effect<number>;
  /** Delivers each new clock to `member` from now on. */
  readonly join: (member: Follower<Refused>) => Effect.Effect<void>;
  /** Stops delivering clocks to `member`. */
  readonly leave: (member: Follower<Refused>) => Effect.Effect<void>;
  /** Refuses every call with `reason`, until called again with null. */
  readonly refuse: (reason: string | null) => Effect.Effect<void>;
  /** Refuses every seek as stale while `refused`. */
  readonly refuseSeeks: (refused: boolean) => Effect.Effect<void>;
  /** Moves the clock as a member elsewhere does, and delivers it. */
  readonly move: (move: ClockMove) => Effect.Effect<SessionClock, Refused>;
  /** Moves the clock without telling members, who hear of it only when a test applies it. */
  readonly moveUnheard: (move: ClockMove) => Effect.Effect<SessionClock, Refused>;
}

/**
 * A session's clock as the core keeps it: play is absolute, a pause always makes a new revision
 * (of a paused clock too), a seek needs the current revision, a play or a pause that carries a
 * revision applies only at it, and every move anchors at the server's time. Members it holds get
 * each new clock, as the subscription delivers it, one latency after the move.
 */
export const makeSession = (initial: SessionClock): Effect.Effect<Session> =>
  Effect.gen(function* () {
    const clock = yield* Ref.make(initial);
    const followers = yield* Ref.make<ReadonlyArray<Follower<Refused>>>([]);
    const refusing = yield* Ref.make<string | null>(null);
    const seeksRefused = yield* Ref.make(false);

    const serverNow = Effect.map(Clock.currentTimeMillis, (now) =>
      EpochMillis.make(now + SERVER_OFFSET_MS),
    );

    const publish = Effect.gen(function* () {
      const current = yield* Ref.get(clock);

      yield* Effect.forEach(yield* Ref.get(followers), (member) => member.apply(current), {
        discard: true,
      });
    });

    const control = (move: ClockMove, published = true) =>
      Effect.gen(function* () {
        yield* Effect.sleep(LATENCY_MS);

        const reason = yield* Ref.get(refusing);

        if (reason !== null) return yield* new Refused({ reason });

        const now = yield* serverNow;
        const current = yield* Ref.get(clock);

        const moved = (fields: Partial<SessionClock>): SessionClock => ({
          ...current,
          ...fields,
          anchorServerTime: now,
          revision: current.revision + 1,
        });

        const stale = move.revision !== undefined && move.revision !== current.revision;

        if (stale || (move.kind === "seek" && (yield* Ref.get(seeksRefused)))) {
          return yield* new Refused({ reason: "conflict" });
        }

        const next = Match.value(move).pipe(
          Match.discriminatorsExhaustive("kind")({
            play: () => (current.status === "playing" ? current : moved({ status: "playing" })),
            pause: () => moved({ status: "paused", positionAtAnchorMs: positionAt(current, now) }),
            seek: (seek) => moved({ positionAtAnchorMs: seek.positionMs }),
          }),
        );

        yield* Ref.set(clock, next);

        if (published) yield* Effect.forkDetach(Effect.delay(publish, LATENCY_MS));

        yield* Effect.sleep(LATENCY_MS);

        return next;
      });

    const heartbeat = Effect.gen(function* () {
      yield* Effect.sleep(LATENCY_MS);
      const serverTime = yield* serverNow;

      yield* Effect.sleep(LATENCY_MS);

      return { serverTime };
    });

    const shared = Effect.gen(function* () {
      return positionAt(yield* Ref.get(clock), yield* serverNow);
    });

    return {
      port: { heartbeat, control },
      clock: Ref.get(clock),
      shared,
      join: (member: Follower<Refused>) => Ref.update(followers, (all) => [...all, member]),
      leave: (member: Follower<Refused>) =>
        Ref.update(followers, (all) => all.filter((other) => other !== member)),
      refuse: (reason: string | null) => Ref.set(refusing, reason),
      refuseSeeks: (refused: boolean) => Ref.set(seeksRefused, refused),
      move: (move: ClockMove) => control(move),
      moveUnheard: (move: ClockMove) => control(move, false),
    };
  });

/** Moves the test clock on by `ms`, in steps short enough for every timer to fire in order. */
export const advance = (ms: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) yield* TestClock.adjust(20);
  });

/** Starts following `session` with `player` as a member, a second after it begins sampling. */
export const follower = (
  session: Session,
  player: FollowerPlayer,
  options: {
    readonly controls?: boolean;
    readonly pausesForStalls?: boolean;
    readonly resumeHold?: Hold;
  } = {},
): Effect.Effect<Follower<Refused>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const started = yield* Effect.forkChild(
      run({
        player,
        port: session.port,
        clock: yield* session.clock,
        durationMs: () => 3_600_000,
        controls: options.controls ?? false,
        pausesForStalls: options.pausesForStalls ?? false,
        resumeHold: options.resumeHold ?? null,
      }),
    );

    yield* advance(1_000);

    const member = yield* Fiber.join(started);

    yield* session.join(member);

    return member;
  });

/** Runs `effect` while the test clock moves on, as a call over the network needs. */
export const meanwhile = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);

    yield* advance(500);

    return yield* Fiber.join(fiber);
  });

/** Runs `body` against a session with `clock`, on a test clock set to `START`. */
export const scenario = (
  clock: Partial<SessionClock>,
  body: (session: Session) => Effect.Effect<void, Refused, Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const testClock = yield* Layer.build(TestClock.layer());

        yield* Effect.gen(function* () {
          yield* TestClock.setTime(START);

          const session = yield* makeSession({
            status: "paused",
            positionAtAnchorMs: 0,
            anchorServerTime: START + SERVER_OFFSET_MS,
            playbackRate: 1,
            revision: 0,
            ...clock,
          });

          yield* body(session);
        }).pipe(Effect.provideContext(testClock));
      }),
    ),
  );

/** A session that has played for a minute from the start, at revision 4. */
export const playingForAMinute: Partial<SessionClock> = {
  status: "playing",
  positionAtAnchorMs: 0,
  anchorServerTime: START + SERVER_OFFSET_MS - 60_000,
  revision: 4,
};
