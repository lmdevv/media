import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { positionAt } from "./clock";
import type { SessionClock } from "./clock";
import { FOLLOWER_TUNABLES, PlayerCommand, follow } from "./follower-policy";
import type { FollowInput, PlayerReading } from "./follower-policy";
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
