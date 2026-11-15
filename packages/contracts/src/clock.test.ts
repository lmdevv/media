import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  NEXT_EPISODE_COUNTDOWN_MS,
  countdownLeftMs,
  creditsStartMs,
  estimateClockOffset,
  isNewerRevision,
  positionAt,
  toServerTime,
} from "./clock";
import type { SessionClock } from "./clock";
import { EpochMillis } from "./units";

const at = (value: number): EpochMillis => EpochMillis.make(value);

const anchored = (status: SessionClock["status"], playbackRate: number): SessionClock => ({
  status,
  positionAtAnchorMs: 60_000,
  anchorServerTime: 1_000_000,
  playbackRate,
  revision: 3,
});

const instants = fc.integer({ min: 0, max: 4_000_000_000_000 });

describe("positionAt", () => {
  it("holds a paused clock at its anchor", () => {
    fc.assert(
      fc.property(instants, (now) => {
        expect(positionAt(anchored("paused", 1), at(now))).toBe(60_000);
      }),
    );
  });

  it("advances a playing clock from its anchor at its rate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 86_400_000 }),
        fc.double({ min: 0.5, max: 2, noNaN: true }),
        (elapsed, rate) => {
          const playing = anchored("playing", rate);

          expect(positionAt(playing, at(playing.anchorServerTime + elapsed))).toBeCloseTo(
            60_000 + elapsed * rate,
            6,
          );
        },
      ),
    );
  });

  it("never moves backwards when the server reading predates the anchor", () => {
    expect(positionAt(anchored("playing", 1), at(500_000))).toBe(60_000);
  });
});

describe("isNewerRevision", () => {
  it("accepts the first clock and only higher revisions after it", () => {
    expect(isNewerRevision({ revision: 0 }, undefined)).toBe(true);
    expect(isNewerRevision({ revision: 4 }, { revision: 3 })).toBe(true);
    expect(isNewerRevision({ revision: 3 }, { revision: 3 })).toBe(false);
    expect(isNewerRevision({ revision: 2 }, { revision: 3 })).toBe(false);
  });
});

describe("creditsStartMs", () => {
  it("counts the last tenth as credits, at most 30 seconds of them", () => {
    expect(creditsStartMs(100_000)).toBe(90_000);
    expect(creditsStartMs(3_600_000)).toBe(3_570_000);
  });
});

const playingFrom = (positionAtAnchorMs: number): SessionClock => ({
  status: "playing",
  positionAtAnchorMs,
  anchorServerTime: 1_000_000,
  playbackRate: 1,
  revision: 1,
});

describe("countdownLeftMs", () => {
  const durationMs = 600_000;
  const credits = creditsStartMs(durationMs);

  it("runs nothing before the credits", () => {
    expect(countdownLeftMs(playingFrom(credits - 1), at(1_000_000), durationMs)).toBeNull();
  });

  it("counts down on the session's clock from the credits on", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: NEXT_EPISODE_COUNTDOWN_MS }), (into) => {
        expect(countdownLeftMs(playingFrom(credits), at(1_000_000 + into), durationMs)).toBe(
          NEXT_EPISODE_COUNTDOWN_MS - into,
        );
      }),
    );
  });

  it("holds while the session is paused", () => {
    const paused: SessionClock = { ...playingFrom(credits + 4_000), status: "paused" };

    expect(countdownLeftMs(paused, at(9_000_000), durationMs)).toBe(6_000);
  });

  it("ends at the item's end when its credits are shorter than the countdown", () => {
    expect(countdownLeftMs(playingFrom(54_000), at(1_000_000), 60_000)).toBe(6_000);
    expect(countdownLeftMs(playingFrom(54_000), at(1_100_000), 60_000)).toBe(0);
  });

  it("runs nothing for an item of unknown length", () => {
    expect(countdownLeftMs(playingFrom(credits), at(1_000_000), 0)).toBeNull();
  });
});

describe("estimateClockOffset", () => {
  it("returns nothing without samples", () => {
    expect(estimateClockOffset([])).toBeUndefined();
  });

  it("recovers the true offset from a symmetric round trip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3_600_000, max: 3_600_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        (offset, oneWay) => {
          const sentAt = 5_000_000;

          const estimate = estimateClockOffset([
            { sentAt, serverTime: at(sentAt + oneWay + offset), receivedAt: sentAt + 2 * oneWay },
          ]);

          expect(estimate).toStrictEqual({ offsetMs: offset, roundTripMs: 2 * oneWay });
        },
      ),
    );
  });

  it("trusts the sample with the shortest round trip", () => {
    const estimate = estimateClockOffset([
      { sentAt: 0, serverTime: at(10_400), receivedAt: 800 },
      { sentAt: 1_000, serverTime: at(11_050), receivedAt: 1_100 },
    ]);

    expect(estimate).toStrictEqual({ offsetMs: 10_000, roundTripMs: 100 });
    expect(toServerTime(2_000, { offsetMs: 10_000.5, roundTripMs: 100 })).toBe(12_001);
  });

  it("ignores a sample whose client clock stepped back during the round trip", () => {
    const estimate = estimateClockOffset([
      { sentAt: 5_000, serverTime: at(15_050), receivedAt: 3_000 },
      { sentAt: 1_000, serverTime: at(11_050), receivedAt: 1_100 },
    ]);

    expect(estimate).toStrictEqual({ offsetMs: 10_000, roundTripMs: 100 });
    expect(
      estimateClockOffset([{ sentAt: 5_000, serverTime: at(15_050), receivedAt: 3_000 }]),
    ).toBeUndefined();
  });
});
