import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { believedPosition, placed, playedOnFromJumpMs, reported } from "./playhead";

const REPORT_MS = 250;

describe("reported", () => {
  it("believes a player that plays on at its rate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom(0.5, 1, 1.5, 2),
        fc.integer({ min: 1, max: 400 }),
        (startMs, rate, reports) => {
          let playhead = placed(startMs, 0);

          for (let report = 1; report <= reports; report += 1) {
            playhead = reported(
              playhead,
              startMs + report * REPORT_MS * rate,
              report * REPORT_MS,
              rate,
            );
          }

          return playhead.believed.positionMs === startMs + reports * REPORT_MS * rate;
        },
      ),
    );
  });

  it("never believes a player stuck somewhere it could not have played to", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60_000, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 2_000 }),
        (believedMs, stuckMs, reports) => {
          fc.pre(Math.abs(stuckMs - believedMs) > 20_000);
          let playhead = placed(believedMs, 0);

          for (let report = 1; report <= reports; report += 1) {
            playhead = reported(playhead, stuckMs, report * REPORT_MS, 1);
          }

          return (
            playhead.believed.positionMs === believedMs &&
            believedPosition(playhead, stuckMs, reports * REPORT_MS, 1) === believedMs
          );
        },
      ),
    );
  });

  it("never believes a player skipping ahead faster than it plays", () => {
    let playhead = placed(2_160_000, 0);

    for (let segment = 1; segment <= 100; segment += 1) {
      playhead = reported(playhead, 2_160_000 + segment * 6_000, segment * 10, 1);
    }

    expect(playhead.believed.positionMs).toBe(2_160_000);
  });

  it("believes a jump once the player plays on from it for a few seconds", () => {
    let playhead = reported(placed(600_000, 0), 1_500_000, REPORT_MS, 1);

    expect(playhead.believed.positionMs).toBe(600_000);

    for (let report = 1; report <= 12; report += 1) {
      playhead = reported(
        playhead,
        1_500_000 + report * REPORT_MS,
        REPORT_MS + report * REPORT_MS,
        1,
      );
    }

    expect(playhead.believed.positionMs).toBe(1_503_000);
  });
});

describe("playedOnFromJumpMs", () => {
  it("counts how much media the player played on from its jump", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom(0.5, 1, 2),
        fc.integer({ min: 1, max: 11 }),
        (jumpMs, rate, reports) => {
          const fromMs = jumpMs + 60_000;
          let playhead = reported(placed(0, 0), fromMs, REPORT_MS, rate);

          for (let report = 1; report <= reports; report += 1) {
            playhead = reported(
              playhead,
              fromMs + report * REPORT_MS * rate,
              REPORT_MS + report * REPORT_MS,
              rate,
            );
          }

          const nowMs = REPORT_MS + reports * REPORT_MS;

          return (
            playedOnFromJumpMs(playhead, fromMs + reports * REPORT_MS * rate, nowMs, rate) ===
            reports * REPORT_MS * rate
          );
        },
      ),
    );
  });

  it("counts the media played at each rate at the rate it played at", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0.5, 0.75, 1, 1.25, 1.5, 2),
        fc.constantFrom(0.5, 0.75, 1, 1.25, 1.5, 2),
        fc.integer({ min: 1, max: 10 }),
        (before, after, reportsBefore) => {
          const fromMs = 2_000_000;
          let playhead = reported(placed(600_000, 0), fromMs, REPORT_MS, before);
          let positionMs = fromMs;
          let atMs = REPORT_MS;

          for (let report = 1; report <= 11; report += 1) {
            const rate = report <= reportsBefore ? before : after;

            positionMs += REPORT_MS * rate;
            atMs += REPORT_MS;
            playhead = reported(playhead, positionMs, atMs, rate);
          }

          return (
            Math.abs(
              playedOnFromJumpMs(playhead, positionMs, atMs, after) - (positionMs - fromMs),
            ) < 1e-6
          );
        },
      ),
    );
  });

  it("counts nothing for a skip that lands without playing on", () => {
    let playhead = placed(2_160_000, 0);

    for (let segment = 1; segment <= 100; segment += 1) {
      playhead = reported(playhead, 2_160_000 + segment * 6_000, segment * 10, 1);
    }

    expect(playedOnFromJumpMs(playhead, 2_760_000, 1_000, 1)).toBe(0);
    expect(playedOnFromJumpMs(playhead, 2_760_000, 3_000, 1)).toBe(0);
  });

  it("counts no more media than the player could have played since its jump", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        fc.constantFrom(0.5, 1, 2),
        (aheadMs, elapsedMs, rate) => {
          const landedMs = 2_000_000;
          const playhead = reported(placed(600_000, 0), landedMs, 1_000, rate);

          return (
            playedOnFromJumpMs(playhead, landedMs + aheadMs, 1_000 + elapsedMs, rate) <=
            elapsedMs * rate
          );
        },
      ),
    );
  });

  it("counts nothing for a skip that races on in short steps", () => {
    let playhead = placed(600_000, 0);

    for (let step = 1; step <= 80; step += 1) {
      playhead = reported(playhead, 2_700_000 + step * 1_500, step * 10, 1);
    }

    expect(playedOnFromJumpMs(playhead, 2_820_000, 800, 1)).toBeLessThan(500);
  });

  it("counts nothing without a jump", () => {
    expect(playedOnFromJumpMs(placed(600_000, 0), 601_000, 1_000, 1)).toBe(0);
  });
});
