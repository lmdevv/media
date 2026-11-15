import { Clock, Data, Effect, Fiber, Layer, Match, Ref, Result } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { positionAt } from "./clock";
import type { SessionClock } from "./clock";
import { run } from "./follower";
import type { ClockMove, Follower, FollowerPlayer, FollowerPlayerEvent } from "./follower";
import { FOLLOWER_TUNABLES } from "./follower-policy";
import { EpochMillis } from "./units";

const START = 1_760_000_000_000;

const SERVER_OFFSET_MS = 7_000;

const LATENCY_MS = 40;

class Refused extends Data.TaggedError("Refused")<{ readonly reason: string }> {}

/** A player whose media clock runs on the test clock, with controls to act as the viewer. */
interface FakePlayer extends FollowerPlayer {
  readonly viewerPause: () => void;
  readonly viewerPlay: () => void;
  readonly viewerSeek: (positionMs: number) => void;
  readonly stall: () => void;
  readonly recover: () => void;
  readonly blockAutoplay: (blocked: boolean) => void;
}

const makePlayer = (positionMs: number) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const listeners = new Set<(event: FollowerPlayerEvent) => void>();
    let base = positionMs;
    let since = clock.currentTimeMillisUnsafe();
    let paused = true;
    let stalled = false;
    let rate = 1;
    let blocked = false;

    const position = (): number =>
      paused || stalled ? base : base + (clock.currentTimeMillisUnsafe() - since) * rate;

    const settle = (): void => {
      base = position();
      since = clock.currentTimeMillisUnsafe();
    };

    const emit = (event: FollowerPlayerEvent): void => {
      for (const listener of listeners) listener(event);
    };

    const start = (): void => {
      if (!paused) return;
      settle();
      paused = false;

      if (!stalled) emit("playing");
    };

    const stop = (): void => {
      if (paused) return;
      settle();
      paused = true;
      emit("paused");
    };

    const seekTo = (target: number): void => {
      settle();
      base = Math.max(0, target);
      emit("seeked");
    };

    const player: FakePlayer = {
      positionMs: position,
      isPaused: () => paused,
      isBuffering: () => stalled && !paused,
      playbackRate: () => rate,
      setPlaybackRate: (next) => {
        settle();
        rate = next;
      },
      seek: seekTo,
      play: () => {
        if (blocked) return Promise.reject(new Error("NotAllowedError"));
        start();

        return Promise.resolve();
      },
      pause: stop,
      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      viewerPause: stop,
      viewerPlay: () => {
        blocked = false;
        start();
      },
      viewerSeek: seekTo,
      stall: () => {
        settle();
        stalled = true;

        if (!paused) emit("waiting");
      },
      recover: () => {
        settle();
        stalled = false;

        if (!paused) emit("playing");
      },
      blockAutoplay: (next) => {
        blocked = next;
      },
    };

    return player;
  });

/**
 * A session's clock as the core keeps it: play and pause are absolute, a seek needs the current
 * revision, every move anchors at the server's time. Members it holds get each new clock, as the
 * subscription delivers it, one latency after the move.
 */
const makeSession = (initial: SessionClock) =>
  Effect.gen(function* () {
    const clock = yield* Ref.make(initial);
    const followers = yield* Ref.make<ReadonlyArray<Follower<Refused>>>([]);
    const refusing = yield* Ref.make<string | null>(null);

    const serverNow = Effect.map(Clock.currentTimeMillis, (now) =>
      EpochMillis.make(now + SERVER_OFFSET_MS),
    );

    const publish = Effect.gen(function* () {
      const current = yield* Ref.get(clock);

      yield* Effect.forEach(yield* Ref.get(followers), (member) => member.apply(current), {
        discard: true,
      });
    });

    const control = (move: ClockMove) =>
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

        if (move.kind === "seek" && move.revision !== current.revision) {
          return yield* new Refused({ reason: "conflict" });
        }

        const next = Match.value(move).pipe(
          Match.discriminatorsExhaustive("kind")({
            play: () => (current.status === "playing" ? current : moved({ status: "playing" })),
            pause: () =>
              current.status === "paused"
                ? current
                : moved({ status: "paused", positionAtAnchorMs: positionAt(current, now) }),
            seek: (seek) => moved({ positionAtAnchorMs: seek.positionMs }),
          }),
        );

        yield* Ref.set(clock, next);
        yield* Effect.forkDetach(Effect.delay(publish, LATENCY_MS));
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
      refuse: (reason: string | null) => Ref.set(refusing, reason),
      move: (move: ClockMove) => control(move),
    };
  });

type Session = Effect.Success<ReturnType<typeof makeSession>>;

const advance = (ms: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) yield* TestClock.adjust(20);
  });

const follower = (
  session: Session,
  player: FakePlayer,
  options: { readonly controls?: boolean; readonly pausesForStalls?: boolean } = {},
) =>
  Effect.gen(function* () {
    const started = yield* Effect.forkChild(
      run({
        player,
        port: session.port,
        clock: yield* session.clock,
        durationMs: 3_600_000,
        controls: options.controls ?? false,
        pausesForStalls: options.pausesForStalls ?? false,
      }),
    );

    yield* advance(1_000);

    const member = yield* Fiber.join(started);

    yield* session.join(member);

    return member;
  });

/** Runs `effect` while the test clock moves on, as a call over the network needs. */
const meanwhile = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);

    yield* advance(500);

    return yield* Fiber.join(fiber);
  });

const driftOf = (session: Session, player: FakePlayer) =>
  Effect.map(session.shared, (shared) => player.positionMs() - shared);

const scenario = (
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

const playingForAMinute: Partial<SessionClock> = {
  status: "playing",
  positionAtAnchorMs: 0,
  anchorServerTime: START + SERVER_OFFSET_MS - 60_000,
  revision: 4,
};

const inSync = FOLLOWER_TUNABLES.inSyncMs;

describe("follower", () => {
  it("estimates the server clock offset from the best round trip", () =>
    scenario({}, (session) =>
      Effect.gen(function* () {
        const member = yield* follower(session, yield* makePlayer(0));
        const { offset } = yield* member.current;

        expect(offset?.offsetMs).toBeCloseTo(SERVER_OFFSET_MS, 0);
        expect(offset?.roundTripMs).toBe(2 * LATENCY_MS);
      }),
    ));

  it("seeks a late joiner straight to the live position and keeps it in sync", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const member = yield* follower(session, player);

        expect(player.isPaused()).toBe(false);
        expect(Math.abs(yield* driftOf(session, player))).toBeLessThanOrEqual(inSync);

        yield* advance(30_000);
        expect(Math.abs(yield* driftOf(session, player))).toBeLessThanOrEqual(inSync);
        expect((yield* member.current).follow).toBe("following");
      }),
    ));

  it("keeps two members within a quarter second of each other through moves", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const aiko = yield* makePlayer(55_000);
        const host = yield* follower(session, lucia, { controls: true });

        yield* follower(session, aiko);

        for (const move of [
          { kind: "pause" },
          { kind: "play" },
          { kind: "seek", positionMs: 600_000 },
        ] as const) {
          yield* meanwhile(host.move(move));
          yield* advance(5_000);
          expect(Math.abs(lucia.positionMs() - aiko.positionMs())).toBeLessThan(250);
        }

        expect(lucia.isPaused()).toBe(false);
        expect(Math.abs(yield* driftOf(session, aiko))).toBeLessThanOrEqual(inSync);
      }),
    ));

  it("holds a paused session's player at the anchor and plays when someone plays", () =>
    scenario({ positionAtAnchorMs: 90_000 }, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);

        yield* follower(session, player);
        expect(player.isPaused()).toBe(true);
        expect(player.positionMs()).toBe(90_000);

        yield* meanwhile(session.move({ kind: "play" }));
        yield* advance(2_000);
        expect(player.isPaused()).toBe(false);
        expect(Math.abs(yield* driftOf(session, player))).toBeLessThanOrEqual(inSync);
      }),
    ));

  it("drops a clock older than the one it applied", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const member = yield* follower(session, player);
        const fresh = yield* session.clock;

        yield* member.apply({ ...fresh, status: "paused", revision: fresh.revision - 1 });
        yield* advance(1_000);

        expect((yield* member.current).clock).toStrictEqual(fresh);
        expect(player.isPaused()).toBe(false);
      }),
    ));

  it("returns a refused seek to the clock", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const member = yield* follower(session, player, { controls: true });

        yield* session.refuse("no-control");

        const refused = yield* meanwhile(
          Effect.result(member.move({ kind: "seek", positionMs: 1_000_000 })),
        );

        expect(Result.isFailure(refused) && refused.failure.reason).toBe("no-control");
        yield* advance(4_000);
        expect(Math.abs(yield* driftOf(session, player))).toBeLessThanOrEqual(inSync);
      }),
    ));

  it("brings back a member who may not control from their own seek", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);

        yield* follower(session, player);
        player.viewerSeek(400_000);
        yield* advance(4_000);

        expect((yield* session.clock).revision).toBe(4);
        expect(Math.abs(yield* driftOf(session, player))).toBeLessThanOrEqual(inSync);
      }),
    ));

  it("lets a member who may not control pause their own player, and follows when they play", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const member = yield* follower(session, player);

        player.viewerPause();
        yield* advance(3_000);
        expect((yield* member.current).follow).toBe("detached");
        expect(player.isPaused()).toBe(true);
        expect((yield* session.clock).status).toBe("playing");

        player.viewerPlay();
        yield* advance(4_000);
        expect((yield* member.current).follow).toBe("following");
        expect(Math.abs(yield* driftOf(session, player))).toBeLessThanOrEqual(inSync);
      }),
    ));

  it("moves the session for a controller's pause from outside its controls", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);

        yield* follower(session, player, { controls: true });
        player.viewerPause();
        yield* advance(1_000);

        expect((yield* session.clock).status).toBe("paused");
        expect(player.isPaused()).toBe(true);
      }),
    ));

  it("waits for a click when the platform blocks playback", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);

        player.blockAutoplay(true);

        const member = yield* follower(session, player);

        expect((yield* member.current).follow).toBe("blocked");

        player.viewerPlay();
        yield* advance(20_000);
        expect((yield* member.current).follow).toBe("following");
        expect(Math.abs(yield* driftOf(session, player))).toBeLessThanOrEqual(inSync);
      }),
    ));

  it("pauses the session where the host's player stalled, and plays it on once it recovers", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const aiko = yield* makePlayer(0);

        yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        yield* follower(session, aiko);
        yield* advance(4_000);

        lucia.stall();

        const stalledAt = lucia.positionMs();

        yield* advance(3_000);

        const held = yield* session.clock;

        expect(held.status).toBe("paused");
        expect(held.positionAtAnchorMs).toBeCloseTo(stalledAt, -1);
        expect(aiko.isPaused()).toBe(true);

        lucia.recover();
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("playing");
        expect(Math.abs(lucia.positionMs() - aiko.positionMs())).toBeLessThan(250);
      }),
    ));

  it("leaves the session paused when someone else moved it during the host's stall", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);

        yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        yield* advance(4_000);
        lucia.stall();
        yield* advance(3_000);

        const held = yield* session.clock;

        yield* meanwhile(
          session.move({ kind: "seek", positionMs: 30_000, revision: held.revision }),
        );
        yield* advance(500);
        lucia.recover();
        yield* advance(3_000);

        const after = yield* session.clock;

        expect(after.status).toBe("paused");
        expect(after.positionAtAnchorMs).toBe(30_000);
        expect(lucia.isPaused()).toBe(true);
      }),
    ));

  it("does not pause the session for the stall after its own catch-up seek", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);

        yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        lucia.stall();
        yield* advance(1_500);
        lucia.recover();
        yield* advance(2_000);

        expect((yield* session.clock).status).toBe("playing");
      }),
    ));
});
