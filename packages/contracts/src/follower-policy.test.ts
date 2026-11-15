import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { positionAt } from "./clock";
import type { SessionClock } from "./clock";
import {
  FOLLOWER_TUNABLES,
  PlayerCommand,
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
  EventFacts,
  Expected,
  FollowInput,
  FollowerPlayerEvent,
  PendingCommand,
  PlayerReading,
} from "./follower-policy";
import { EpochMillis } from "./units";

const NOW = EpochMillis.make(1_760_000_000_000);

const clocksWith = (status: SessionClock["status"]): fc.Arbitrary<SessionClock> =>
  fc.record({
    status: fc.constant(status),
    positionAtAnchorMs: fc.integer({ min: 0, max: 10_000_000 }),
    anchorServerTime: fc.integer({ min: 0, max: 600_000 }).map((ago) => NOW - ago),
    playbackRate: fc.constantFrom(0.5, 1, 1.25, 2),
    revision: fc.nat(),
  });

const playing = clocksWith("playing");

const paused = clocksWith("paused");

const players = fc.record({
  positionMs: fc.integer({ min: 0, max: 20_000_000 }),
  paused: fc.boolean(),
  buffering: fc.boolean(),
  playbackRate: fc.constantFrom(0.95, 1, 1.05, 2),
  fixedRate: fc.constant(false),
});

const isSeek = PlayerCommand.$is("Seek");

const near = (clock: SessionClock, offsetMs: number, isPaused: boolean): PlayerReading => ({
  positionMs: positionAt(clock, NOW) + offsetMs,
  paused: isPaused,
  buffering: false,
  playbackRate: clock.playbackRate,
  fixedRate: false,
});

const input = (
  clock: SessionClock,
  player: PlayerReading,
  options: Partial<Omit<FollowInput, "clock" | "player">> = {},
): FollowInput => ({
  clock,
  serverNow: NOW,
  player,
  recentlySought: false,
  settling: false,
  durationMs: null,
  ...options,
});

describe("follow", () => {
  it("leaves an in-sync player at the session's rate alone", () => {
    fc.assert(
      fc.property(playing, fc.integer({ min: -100, max: 100 }), (clock, offset) => {
        expect(follow(input(clock, near(clock, offset, false)))).toStrictEqual({
          commands: [],
          driftMs: offset,
          settling: false,
        });
      }),
    );
  });

  it("seeks only beyond the seek threshold and never during the cooldown", () => {
    fc.assert(
      fc.property(playing, players, fc.boolean(), (clock, player, recentlySought) => {
        const decision = follow(input(clock, player, { recentlySought }));
        const distance = Math.abs(player.positionMs - positionAt(clock, NOW));

        if (decision.commands.some(isSeek)) {
          expect(recentlySought).toBe(false);
          expect(distance).toBeGreaterThanOrEqual(FOLLOWER_TUNABLES.seekMs);
        }
      }),
    );
  });

  it("seeks a player that cannot change its rate past its own threshold, and never nudges it", () => {
    fc.assert(
      fc.property(
        playing,
        fc.integer({ min: -5_000, max: 5_000 }),
        fc.boolean(),
        (clock, offset, recentlySought) => {
          const cast = { ...near(clock, offset, false), playbackRate: 1, fixedRate: true };
          const { commands } = follow(input(clock, cast, { recentlySought }));
          const far = Math.abs(offset) >= FOLLOWER_TUNABLES.fixedRateSeekMs;

          expect(commands.some(PlayerCommand.$is("SetRate"))).toBe(false);
          expect(commands.some(isSeek)).toBe(far && !recentlySought);
        },
      ),
    );
  });

  it("waits out a stall in a playing session", () => {
    fc.assert(
      fc.property(playing, players, fc.boolean(), (clock, player, settling) => {
        expect(follow(input(clock, { ...player, buffering: true }, { settling }))).toStrictEqual({
          commands: [],
          driftMs: null,
          settling,
        });
      }),
    );
  });

  it("nudges toward the shared position between the thresholds", () => {
    fc.assert(
      fc.property(
        playing,
        fc.integer({ min: 200, max: 1_400 }),
        fc.boolean(),
        (clock, gap, ahead) => {
          const decision = follow(input(clock, near(clock, ahead ? gap : -gap, false)));
          const [command] = decision.commands;

          expect(decision.commands).toHaveLength(1);
          expect(command !== undefined && PlayerCommand.$is("SetRate")(command)).toBe(true);

          if (command !== undefined && PlayerCommand.$is("SetRate")(command)) {
            expect(
              ahead ? command.rate < clock.playbackRate : command.rate > clock.playbackRate,
            ).toBe(true);
          }
        },
      ),
    );
  });

  it("settles near the shared position after drifting out of sync or onto a new clock", () => {
    fc.assert(
      fc.property(
        playing,
        fc.integer({ min: FOLLOWER_TUNABLES.settleMs + 1, max: FOLLOWER_TUNABLES.seekMs - 1 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 2 }),
        (clock, gap, ahead, lateness) => {
          let settling = gap <= FOLLOWER_TUNABLES.inSyncMs;
          const tickMs = FOLLOWER_TUNABLES.correctionIntervalMs * lateness;
          let offset = ahead ? gap : -gap;
          let rate = clock.playbackRate;

          for (let tick = 0; tick < 1_000; tick += 1) {
            const player = { ...near(clock, offset, false), playbackRate: rate };
            const decision = follow(input(clock, player, { settling }));

            settling = decision.settling;

            for (const command of decision.commands) {
              if (PlayerCommand.$is("SetRate")(command)) rate = command.rate;
            }

            if (rate === clock.playbackRate) break;
            offset += (rate - clock.playbackRate) * tickMs;
          }

          const step = clock.playbackRate * FOLLOWER_TUNABLES.nudgeRate * tickMs;

          expect(rate).toBe(clock.playbackRate);
          expect(settling).toBe(false);
          expect(Math.abs(offset)).toBeLessThanOrEqual(FOLLOWER_TUNABLES.settleMs + step);
        },
      ),
    );
  });

  it("turns a running nudge around when a new clock puts the target behind it", () => {
    fc.assert(
      fc.property(
        playing,
        fc.integer({ min: FOLLOWER_TUNABLES.settleMs + 1, max: FOLLOWER_TUNABLES.inSyncMs }),
        fc.boolean(),
        (clock, gap, ahead) => {
          const away = clock.playbackRate * (1 + (ahead ? 1 : -1) * FOLLOWER_TUNABLES.nudgeRate);
          const player = { ...near(clock, ahead ? gap : -gap, false), playbackRate: away };
          const [command] = follow(input(clock, player, { settling: true })).commands;

          expect(command !== undefined && PlayerCommand.$is("SetRate")(command)).toBe(true);

          if (command !== undefined && PlayerCommand.$is("SetRate")(command)) {
            expect(
              ahead ? command.rate < clock.playbackRate : command.rate > clock.playbackRate,
            ).toBe(true);
          }
        },
      ),
    );
  });

  it("holds a paused session's player paused at the anchor", () => {
    fc.assert(
      fc.property(paused, players, (clock, player) => {
        const { commands } = follow(input(clock, player, { recentlySought: true }));

        expect(commands.some(PlayerCommand.$is("Play"))).toBe(false);
        expect(commands.some(PlayerCommand.$is("Pause"))).toBe(!player.paused);

        const far =
          Math.abs(player.positionMs - clock.positionAtAnchorMs) > FOLLOWER_TUNABLES.inSyncMs;

        expect(commands.some(isSeek)).toBe(far);
      }),
    );
  });

  it("waits at the end of its media once the session's clock runs past it", () => {
    fc.assert(
      fc.property(
        playing,
        fc.integer({ min: 0, max: 60_000 }),
        fc.integer({ min: -400, max: 400 }),
        (clock, past, offset) => {
          const durationMs = Math.max(1, positionAt(clock, NOW) - past);
          const player = { ...near(clock, 0, true), positionMs: durationMs + offset };

          expect(follow(input(clock, player, { durationMs }))).toStrictEqual({
            commands: [],
            driftMs: null,
            settling: false,
          });
        },
      ),
    );
  });

  it("brings a player far behind to the end of its media, without playing it", () => {
    const clock: SessionClock = {
      status: "playing",
      positionAtAnchorMs: 600_000,
      anchorServerTime: NOW,
      playbackRate: 1,
      revision: 2,
    };

    const behind = { ...near(clock, 0, false), positionMs: 100_000 };

    expect(follow(input(clock, behind, { durationMs: 590_000 })).commands).toStrictEqual([
      PlayerCommand.Seek({ positionMs: 590_000 }),
    ]);
  });
});

const expecting = (standsPaused: boolean, pending: ReadonlyArray<PendingCommand>): Expected => ({
  command: 7,
  paused: standsPaused,
  pending,
});

describe("hear", () => {
  it.each<readonly [string, Expected, FollowerPlayerEvent, string, Expected]>([
    ["a pause's own event", expecting(true, ["pause"]), "paused", "command", expecting(true, [])],
    [
      "a `playing` while a pause is pending",
      expecting(true, ["pause"]),
      "playing",
      "catching-up",
      expecting(true, ["pause"]),
    ],
    [
      "a seek's landing while a pause is still pending",
      expecting(true, ["pause", "seek"]),
      "seeked",
      "command",
      expecting(true, ["pause"]),
    ],
    [
      "a `playing` while the load settles",
      expecting(false, ["load"]),
      "playing",
      "catching-up",
      expecting(false, ["load"]),
    ],
    [
      "a `seeked` while the load settles",
      expecting(false, ["load"]),
      "seeked",
      "catching-up",
      expecting(false, ["load"]),
    ],
    ["a pause it expected", expecting(true, []), "paused", "unchanged", expecting(true, [])],
    ["a viewer's play", expecting(true, []), "playing", "change", expecting(false, [])],
    ["a viewer's pause", expecting(false, []), "paused", "change", expecting(true, [])],
    ["a viewer's seek", expecting(false, []), "seeked", "change", expecting(false, [])],
    ["a stall", expecting(false, []), "waiting", "unchanged", expecting(false, [])],
    ["an end", expecting(false, []), "ended", "unchanged", expecting(false, [])],
  ])("judges %s", (_name, before, event, origin, after) => {
    expect(hear(before, event)).toStrictEqual([origin, after]);
  });

  it("numbers each play, pause, and seek, and keeps one play or pause and one seek pending", () => {
    const loading = expectedAtLoad(false);
    const pausing = expectedAfter(loading, PlayerCommand.Pause());
    const sought = expectedAfter(pausing, PlayerCommand.Seek({ positionMs: 5_000 }));
    const played = expectedAfter(sought, PlayerCommand.Play());

    expect(loading).toStrictEqual({ command: 1, paused: false, pending: ["load"] });
    expect(pausing).toStrictEqual({ command: 2, paused: true, pending: ["load", "pause"] });
    expect(played).toStrictEqual({ command: 4, paused: false, pending: ["load", "seek", "play"] });
    expect(expectedAfter(played, PlayerCommand.SetRate({ rate: 1.05 }))).toBe(played);
    expect(expectedAfter(played, PlayerCommand.Seek({ positionMs: 0 })).pending).toStrictEqual([
      "load",
      "play",
      "seek",
    ]);
  });

  it("carries out all but a seek once the player stands in place, and a seek once it landed", () => {
    const pending = expecting(false, ["load", "play", "seek"]);

    expect(expectedInPlace(pending, true)).toStrictEqual(expecting(true, ["seek"]));
    expect(expectedLanded(expectedInPlace(pending, true))).toStrictEqual(expecting(true, []));
  });

  it("never takes an event that arrived while a command was pending as a change", () => {
    const step = fc.oneof(
      fc
        .constantFrom(
          PlayerCommand.Play(),
          PlayerCommand.Pause(),
          PlayerCommand.Seek({ positionMs: 1_000 }),
          PlayerCommand.SetRate({ rate: 1.05 }),
        )
        .map((command) => ({ kind: "command" as const, command })),
      fc
        .constantFrom<FollowerPlayerEvent>("playing", "paused", "seeked", "waiting", "ended")
        .map((event) => ({ kind: "event" as const, event })),
      fc.boolean().map((standsPaused) => ({ kind: "in-place" as const, standsPaused })),
      fc.constant({ kind: "landed" as const }),
    );

    fc.assert(
      fc.property(fc.boolean(), fc.array(step, { maxLength: 40 }), (startPaused, steps) => {
        let expected = expectedAtLoad(startPaused);

        for (const next of steps) {
          const before = expected;

          if (next.kind === "command") expected = expectedAfter(before, next.command);
          else if (next.kind === "in-place") expected = expectedInPlace(before, next.standsPaused);
          else if (next.kind === "landed") expected = expectedLanded(before);
          else {
            const [origin, after] = hear(before, next.event);
            const waiting = before.pending.length > 0;

            expect(["command", "catching-up"].includes(origin)).toBe(waiting);
            expect(after.pending.length).toBe(
              origin === "command" ? before.pending.length - 1 : before.pending.length,
            );
            expected = after;
          }

          const playOrPause = expected.pending.filter(
            (command) => command === "play" || command === "pause",
          );

          expect(playOrPause.length).toBeLessThanOrEqual(1);
          expect(
            expected.pending.filter((command) => command === "seek").length,
          ).toBeLessThanOrEqual(1);
          expect(expected.command).toBeGreaterThanOrEqual(before.command);
        }
      }),
    );
  });
});

const facts = (overrides: Partial<EventFacts>): EventFacts => ({
  event: "playing",
  origin: "change",
  controls: true,
  clock: "paused",
  holding: false,
  paused: false,
  buffering: false,
  atEnd: false,
  offClock: false,
  ...overrides,
});

describe("eventAction", () => {
  it.each<readonly [string, Partial<EventFacts>, EventAction]>([
    ["plays a paused session for a viewer's play", {}, "play"],
    ["never moves the session for a command's own event", { origin: "command" }, "follow"],
    ["never moves the session for a player catching up", { origin: "catching-up" }, "follow"],
    ["follows a `playing` the player no longer stands by", { paused: true }, "follow"],
    ["follows a `playing` while the player stalls", { buffering: true }, "follow"],
    ["follows a viewer's play in a session that plays", { clock: "playing" }, "follow"],
    ["follows a viewer's play without control", { controls: false }, "follow"],
    [
      "pauses a playing session for a viewer's pause",
      { event: "paused", clock: "playing", paused: true },
      "pause",
    ],
    [
      "detaches a viewer without control who paused",
      { event: "paused", clock: "playing", paused: true, controls: false },
      "detach",
    ],
    [
      "leaves a player that paused at its end",
      { event: "paused", clock: "playing", paused: true, atEnd: true },
      "nothing",
    ],
    [
      "leaves a pause while the session is held",
      { event: "paused", clock: "playing", paused: true, holding: true },
      "nothing",
    ],
    [
      "follows a `paused` the player no longer stands by",
      { event: "paused", clock: "playing" },
      "follow",
    ],
    [
      "seeks the session for a viewer's seek off the clock",
      { event: "seeked", offClock: true },
      "seek",
    ],
    ["follows a landing on the clock", { event: "seeked" }, "follow"],
    [
      "follows a seek off the clock without control",
      { event: "seeked", offClock: true, controls: false },
      "follow",
    ],
    ["does nothing for a stall", { event: "waiting" }, "nothing"],
    ["does nothing for an end", { event: "ended" }, "nothing"],
  ])("%s", (_name, overrides, action) => {
    expect(eventAction(facts(overrides))).toBe(action);
  });
});

const sessionAt = (status: SessionClock["status"], revision: number): SessionClock => ({
  status,
  positionAtAnchorMs: 30_000,
  anchorServerTime: NOW,
  playbackRate: 1,
  revision,
});

describe("holdStands", () => {
  it("lets a hold play on only while the session stands paused at its own last revision", () => {
    expect(holdStands(6, sessionAt("paused", 6))).toBe(true);
    expect(holdStands(6, sessionAt("paused", 7))).toBe(false);
    expect(holdStands(6, sessionAt("playing", 6))).toBe(false);
    expect(holdStands(6, sessionAt("paused", 5))).toBe(false);
  });
});
