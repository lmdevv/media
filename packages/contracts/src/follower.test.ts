import { Clock, Effect, Exit, Fiber, Result, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { run } from "./follower";
import type { FollowerPlayer, FollowerState } from "./follower";
import { FOLLOWER_TUNABLES } from "./follower-policy";
import type { FollowerPlayerEvent } from "./follower-policy";
import {
  LATENCY_MS,
  SERVER_OFFSET_MS,
  advance,
  follower,
  meanwhile,
  playingForAMinute,
  scenario,
} from "./testing/follower-session";
import type { Session } from "./testing/follower-session";

/** A player whose media clock runs on the test clock, with controls to act as the viewer. */
interface FakePlayer extends FollowerPlayer {
  readonly viewerPause: () => void;
  readonly viewerPlay: () => void;
  readonly viewerSeek: (positionMs: number) => void;
  readonly stall: () => void;
  readonly recover: () => void;
  readonly blockAutoplay: (blocked: boolean) => void;
  /** Says `playing` as a media element does once a seek lands while it plays. */
  readonly sayPlaying: () => void;
  /** Keeps events from listeners until `deliverEvents`, as a slow bridge from native code does. */
  readonly delayEvents: () => void;
  readonly deliverEvents: () => void;
  /** Makes `pause` take effect only at `catchUp`, as a native player's may. */
  readonly lagPauses: () => void;
  readonly catchUp: () => void;
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
    let delayed: Array<FollowerPlayerEvent> | null = null;
    let lagging = false;
    let pauseOwed = false;

    const position = (): number =>
      paused || stalled ? base : base + (clock.currentTimeMillisUnsafe() - since) * rate;

    const settle = (): void => {
      base = position();
      since = clock.currentTimeMillisUnsafe();
    };

    const deliver = (event: FollowerPlayerEvent): void => {
      for (const listener of listeners) listener(event);
    };

    const emit = (event: FollowerPlayerEvent): void => {
      if (delayed === null) deliver(event);
      else delayed.push(event);
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
      pause: () => {
        if (lagging) pauseOwed = true;
        else stop();
      },
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
      sayPlaying: () => emit("playing"),
      delayEvents: () => {
        delayed = [];
      },
      deliverEvents: () => {
        const events = delayed ?? [];

        delayed = null;
        events.forEach(deliver);
      },
      lagPauses: () => {
        lagging = true;
      },
      catchUp: () => {
        lagging = false;

        if (pauseOwed) stop();
        pauseOwed = false;
      },
    };

    return player;
  });

const driftOf = (session: Session, player: FakePlayer) =>
  Effect.map(session.shared, (shared) => player.positionMs() - shared);

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
  it("holds the session again for a later stall after someone overtook the first hold", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);

        yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        yield* advance(4_000);
        lucia.stall();
        yield* advance(3_000);
        yield* meanwhile(session.move({ kind: "play" }));
        lucia.recover();
        yield* advance(5_000);
        expect((yield* session.clock).status).toBe("playing");

        lucia.stall();
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("paused");

        lucia.recover();
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("playing");
      }),
    ));

  it("plays the session on for a hold an earlier follower of the player left", () =>
    scenario({ ...playingForAMinute, status: "paused", positionAtAnchorMs: 70_000 }, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const held = (yield* session.clock).revision;

        lucia.stall();
        lucia.viewerPlay();

        const member = yield* follower(session, lucia, {
          controls: true,
          pausesForStalls: true,
          resumeHold: { kind: "held", revision: held },
        });

        expect((yield* member.current).holding).toStrictEqual({ kind: "held", revision: held });

        lucia.recover();
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("playing");
        expect((yield* member.current).holding).toBeNull();
      }),
    ));
  it("plays the session on when the host's player recovers while its pause is on the way", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const aiko = yield* makePlayer(0);

        yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        yield* follower(session, aiko);
        yield* advance(4_000);
        lucia.stall();
        yield* advance(FOLLOWER_TUNABLES.stallPauseMs + 60);
        lucia.recover();
        yield* advance(3_000);

        expect((yield* session.clock).status).toBe("playing");
        expect(aiko.isPaused()).toBe(false);
        expect(Math.abs(lucia.positionMs() - aiko.positionMs())).toBeLessThan(250);
      }),
    ));
  it("tries again to play the session on when the first play after a stall fails", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);

        yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        yield* advance(4_000);
        lucia.stall();
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("paused");

        yield* session.refuse("unreachable");
        lucia.recover();
        yield* advance(2_000);
        expect((yield* session.clock).status).toBe("paused");

        yield* session.refuse(null);
        yield* advance(2_000);
        expect((yield* session.clock).status).toBe("playing");
        expect(lucia.isPaused()).toBe(false);
      }),
    ));
  it("holds the session at its pause when the seek back to the stall fails", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);

        yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        yield* advance(4_000);
        lucia.stall();
        yield* session.refuseSeeks(true);
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("paused");

        yield* session.refuseSeeks(false);
        lucia.recover();
        yield* advance(2_000);
        expect((yield* session.clock).status).toBe("playing");
        expect(lucia.isPaused()).toBe(false);
      }),
    ));
  it("never plays a paused session again for a `playing` heard before its pause", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const member = yield* follower(session, player, { controls: true });

        yield* advance(4_000);

        const paused = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        // The element says `playing` as a seek lands, and the pause reaches the follower before
        // it reads that event; the player still plays when it does.
        player.lagPauses();
        yield* Effect.andThen(Effect.sync(player.sayPlaying), member.apply(paused));
        yield* advance(1_000);
        player.catchUp();
        yield* advance(2_000);

        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
        expect(player.isPaused()).toBe(true);
      }),
    ));
  it("never plays a paused session again for a `playing` its player reports late", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);

        yield* follower(session, player, { controls: true });
        yield* advance(4_000);

        player.delayEvents();
        player.sayPlaying();

        const paused = yield* meanwhile(session.move({ kind: "pause" }));

        player.deliverEvents();
        yield* advance(3_000);

        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
        expect(player.isPaused()).toBe(true);
      }),
    ));
  it("plays the session on after its stream reloads while the stall's pause is on the way", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const aiko = yield* makePlayer(0);
        const reloads = yield* Scope.make();
        const hosting = { controls: true, pausesForStalls: true } as const;
        const before = yield* Scope.provide(follower(session, lucia, hosting), reloads);

        yield* follower(session, aiko);
        yield* advance(4_000);
        lucia.stall();
        yield* advance(FOLLOWER_TUNABLES.stallPauseMs + 20);

        const { holding: left }: FollowerState = yield* before.current;

        if (left?.kind !== "pausing")
          throw new Error(`expected a pause on its way, got ${left?.kind}`);

        expect((yield* session.clock).status).toBe("playing");

        yield* session.leave(before);
        yield* Scope.close(reloads, Exit.void);

        const after = yield* follower(session, lucia, { ...hosting, resumeHold: left });

        yield* after.apply(yield* session.clock);
        expect((yield* session.clock).status).toBe("paused");
        expect(aiko.isPaused()).toBe(true);
        expect((yield* after.current).holding?.kind).toBe("held");

        lucia.recover();
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("playing");
        expect((yield* after.current).holding).toBeNull();
        expect(Math.abs(lucia.positionMs() - aiko.positionMs())).toBeLessThan(250);
      }),
    ));
  it("drops a late native playing event while a newer pause is still taking effect", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);

        yield* follower(session, player, { controls: true });
        yield* advance(4_000);
        player.delayEvents();
        player.sayPlaying();
        player.lagPauses();

        const paused = yield* meanwhile(session.move({ kind: "pause" }));

        player.deliverEvents();
        yield* advance(200);
        player.catchUp();
        yield* advance(2_000);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
      }),
    ));
  it("keeps an intentional pause during a stall when the player subsequently recovers", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const host = yield* follower(session, player, { controls: true, pausesForStalls: true });

        yield* advance(4_000);
        player.stall();
        yield* advance(3_000);
        yield* meanwhile(host.move({ kind: "pause" }));
        player.recover();
        yield* advance(3_000);
        expect((yield* session.clock).status).toBe("paused");
      }),
    ));
  it("does not resume a deliberate pause after an in-flight stall hold crosses a reload", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const reloads = yield* Scope.make();
        const hosting = { controls: true, pausesForStalls: true } as const;
        const before = yield* Scope.provide(follower(session, player, hosting), reloads);

        yield* advance(4_000);
        player.stall();
        yield* advance(FOLLOWER_TUNABLES.stallPauseMs + 20);

        const { holding: left } = yield* before.current;

        if (left?.kind !== "pausing") throw new Error("expected in-flight stall hold");

        yield* session.leave(before);
        yield* Scope.close(reloads, Exit.void);
        // Host deliberately presses Pause on their other screen while the stream reloads.
        yield* meanwhile(session.move({ kind: "pause" }));

        const paused = yield* session.clock;
        const after = yield* follower(session, player, { ...hosting, resumeHold: left });

        yield* after.apply(yield* session.clock);
        player.recover();
        yield* advance(3_000);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
      }),
    ));
  it("never plays on a session someone paused just before the stall's own pause landed", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const host = yield* follower(session, lucia, { controls: true, pausesForStalls: true });

        yield* advance(4_000);
        lucia.stall();
        yield* advance(FOLLOWER_TUNABLES.stallPauseMs - 60);

        // Lucía pauses on her other screen, and this one hears of it only after its stall's pause
        // went out, which then pauses a session that was already paused.
        const paused = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        yield* host.apply(paused);
        lucia.recover();
        yield* advance(3_000);

        expect((yield* session.clock).status).toBe("paused");
        expect((yield* host.current).holding).toBeNull();
      }),
    ));
  it("never moves the session for an event its player reports while the follower starts on it", () =>
    scenario({ ...playingForAMinute, status: "paused", positionAtAnchorMs: 70_000 }, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(70_000);

        // The stream started playing for the clock it loaded on and the session paused since; the
        // player says so only as the follower starts, and its pause takes effect late.
        player.delayEvents();
        player.viewerPlay();
        player.lagPauses();

        const started = yield* Effect.forkChild(
          run({
            player,
            port: session.port,
            clock: yield* session.clock,
            durationMs: () => 3_600_000,
            controls: true,
            pausesForStalls: false,
          }),
        );

        yield* advance(LATENCY_MS);
        player.deliverEvents();
        yield* advance(1_000);
        yield* session.join(yield* Fiber.join(started));
        yield* advance(200);
        player.catchUp();
        yield* advance(2_000);

        expect(yield* session.clock).toMatchObject({ status: "paused", revision: 4 });
        expect(player.isPaused()).toBe(true);
      }),
    ));
  it("never replays a viewer's play that a newer clock's pause overtook before it was handled", () =>
    scenario({}, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const host = yield* follower(session, player, { controls: true });

        yield* advance(4_000);
        yield* meanwhile(session.moveUnheard({ kind: "play" }));

        const paused = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        // The viewer plays on the player itself, and the newer paused clock reaches the follower
        // before it handles that `playing`; the pause it gives the player takes effect late.
        player.lagPauses();
        yield* Effect.andThen(Effect.sync(player.viewerPlay), host.apply(paused));
        yield* advance(200);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });

        player.catchUp();
        yield* advance(2_000);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
        expect(player.isPaused()).toBe(true);
      }),
    ));
  it("never plays on over a pause made while its stream reloaded, before its clock arrives", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const player = yield* makePlayer(0);
        const reloads = yield* Scope.make();
        const hosting = { controls: true, pausesForStalls: true } as const;
        const before = yield* Scope.provide(follower(session, player, hosting), reloads);

        yield* advance(4_000);
        player.stall();
        yield* advance(FOLLOWER_TUNABLES.stallPauseMs + 20);

        const { holding: left } = yield* before.current;

        if (left?.kind !== "pausing") {
          throw new Error(`expected a pause on its way, got ${left?.kind}`);
        }

        yield* session.leave(before);
        yield* Scope.close(reloads, Exit.void);

        const after = yield* follower(session, player, { ...hosting, resumeHold: left });

        // Lucía pauses on her other screen, and this one hears of it only after its player
        // recovered.
        const paused = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        player.recover();
        yield* advance(200);
        yield* after.apply(paused);
        yield* advance(3_000);

        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
        expect((yield* after.current).holding).toBeNull();
      }),
    ));
  it("never plays on over a pause the follower has not heard of when its player recovers", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const host = yield* follower(session, lucia, { controls: true, pausesForStalls: true });

        yield* advance(4_000);
        lucia.stall();
        yield* advance(3_000);
        expect((yield* host.current).holding?.kind).toBe("held");

        // Lucía pauses on her other screen, and its clock reaches this one only after the player
        // recovered and asked to play the session on.
        const paused = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        lucia.recover();
        yield* advance(1_000);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });

        yield* host.apply(paused);
        yield* advance(2_000);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
        expect((yield* host.current).holding).toBeNull();
      }),
    ));
  it("drops a carried hold someone overtook while the follower was being replaced", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const held = yield* meanwhile(session.move({ kind: "pause" }));

        // Someone seeks the held session while the host's playback starts again, still stalled.
        yield* meanwhile(
          session.move({ kind: "seek", positionMs: 30_000, revision: held.revision }),
        );

        const lucia = yield* makePlayer(0);

        lucia.viewerPlay();
        lucia.stall();

        const host = yield* follower(session, lucia, {
          controls: true,
          pausesForStalls: true,
          resumeHold: { kind: "held", revision: held.revision },
        });

        expect((yield* host.current).holding).toBeNull();
        expect(lucia.isPaused()).toBe(true);
        expect(lucia.positionMs()).toBe(30_000);
      }),
    ));
  it("never pauses the session for a stall once someone moved it, before the follower heard", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const lucia = yield* makePlayer(0);
        const host = yield* follower(session, lucia, { controls: true, pausesForStalls: true });
        const { revision } = yield* session.clock;

        yield* advance(4_000);
        lucia.stall();
        yield* advance(FOLLOWER_TUNABLES.stallPauseMs - 200);

        // Lucía seeks on her other screen just before this one's stall pauses the session.
        const sought = yield* meanwhile(
          session.moveUnheard({ kind: "seek", positionMs: 600_000, revision }),
        );

        expect(yield* session.clock).toStrictEqual(sought);
        expect((yield* host.current).holding).toBeNull();

        lucia.recover();
        yield* host.apply(sought);
        yield* advance(3_000);
        expect(yield* session.clock).toStrictEqual(sought);
        expect(Math.abs(yield* driftOf(session, lucia))).toBeLessThanOrEqual(inSync);
      }),
    ));
  it("plays the session on for a carried hold its new follower's clock has yet to show", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        // The stall's pause and seek back landed, and the host's stream reloaded before the
        // subscription delivered the seek: the new follower starts from the pause's clock.
        const pause = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        const held = yield* meanwhile(
          session.moveUnheard({ kind: "seek", positionMs: 45_000, revision: pause.revision }),
        );

        const lucia = yield* makePlayer(45_000);

        lucia.viewerPlay();
        lucia.stall();

        const host = yield* follower(session, lucia, {
          controls: true,
          pausesForStalls: true,
          resumeHold: { kind: "held", revision: held.revision },
          clock: pause,
        });

        expect((yield* host.current).holding).toStrictEqual({
          kind: "held",
          revision: held.revision,
        });

        yield* host.apply(held);
        lucia.recover();
        yield* advance(3_000);

        expect(yield* session.clock).toMatchObject({
          status: "playing",
          revision: held.revision + 1,
        });
        expect((yield* host.current).holding).toBeNull();
      }),
    ));
  it("plays a carried hold on when its player recovers before its clock shows the hold", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const stalledOn = yield* session.clock;
        const pause = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        const held = yield* meanwhile(
          session.moveUnheard({ kind: "seek", positionMs: 45_000, revision: pause.revision }),
        );

        const lucia = yield* makePlayer(45_000);

        lucia.viewerPlay();
        lucia.stall();

        // The subscription still shows the clock the player stalled on, from before the hold.
        const host = yield* follower(session, lucia, {
          controls: true,
          pausesForStalls: true,
          resumeHold: { kind: "held", revision: held.revision },
          clock: stalledOn,
        });

        lucia.recover();
        yield* advance(3_000);

        expect(yield* session.clock).toMatchObject({
          status: "playing",
          revision: held.revision + 1,
        });
        expect((yield* host.current).holding).toBeNull();
      }),
    ));
  it("never plays a carried hold on over a pause made before its clock showed the hold", () =>
    scenario(playingForAMinute, (session) =>
      Effect.gen(function* () {
        const pause = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        const held = yield* meanwhile(
          session.moveUnheard({ kind: "seek", positionMs: 45_000, revision: pause.revision }),
        );

        const lucia = yield* makePlayer(45_000);

        lucia.viewerPlay();
        lucia.stall();

        const host = yield* follower(session, lucia, {
          controls: true,
          pausesForStalls: true,
          resumeHold: { kind: "held", revision: held.revision },
          clock: pause,
        });

        // Lucía pauses on her other screen, and this one hears of it, and of the hold's own seek,
        // only after its player recovered and asked to play the session on.
        const paused = yield* meanwhile(session.moveUnheard({ kind: "pause" }));

        lucia.recover();
        yield* advance(1_000);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });

        yield* host.apply(held);
        yield* host.apply(paused);
        yield* advance(2_000);
        expect(yield* session.clock).toMatchObject({ status: "paused", revision: paused.revision });
        expect((yield* host.current).holding).toBeNull();
        expect(lucia.isPaused()).toBe(true);
      }),
    ));
});
