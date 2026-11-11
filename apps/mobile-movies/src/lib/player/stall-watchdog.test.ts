import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_RECOVERIES } from "./policy";
import { STALL_AFTER_MS, StallVerdict, checked, watching } from "./stall-watchdog";
import type { StallCheck, StallWatch } from "./stall-watchdog";

const SECOND = 1_000;

const run = (
  start: StallWatch,
  from: number,
  seconds: number,
  see: (atMs: number) => Omit<StallCheck, "atMs">,
) => {
  let watch = start;
  const verdicts: Array<StallVerdict> = [];

  for (let second = 1; second <= seconds; second += 1) {
    const atMs = from + second * SECOND;
    const [next, verdict] = checked(watch, { atMs, ...see(atMs) });

    watch = next;
    verdicts.push(verdict);
  }

  return { watch, verdicts };
};

const recoveries = (verdicts: ReadonlyArray<StallVerdict>): Array<number> =>
  verdicts.flatMap((verdict) => (StallVerdict.$is("Recover")(verdict) ? [verdict.attempt] : []));

const STUCK_AT = 2_170_000;

describe("checked", () => {
  it("waits while playback moves", () => {
    const { verdicts } = run(watching(0, 0), 0, 600, (atMs) => ({
      positionMs: atMs,
      intended: true,
      loading: false,
    }));

    expect(verdicts.every(StallVerdict.$is("Wait"))).toBe(true);
  });

  it("waits while the viewer paused, however long", () => {
    const { verdicts } = run(watching(STUCK_AT, 0), 0, 3_600, () => ({
      positionMs: STUCK_AT,
      intended: false,
      loading: false,
    }));

    expect(verdicts.every(StallVerdict.$is("Wait"))).toBe(true);
  });

  it("recovers a stalled stream, waiting twice as long each time, then gives up", () => {
    const { verdicts } = run(watching(STUCK_AT, 0), 0, 230, () => ({
      positionMs: STUCK_AT,
      intended: true,
      loading: false,
    }));

    const acted = verdicts.flatMap((verdict, index) =>
      StallVerdict.$is("Wait")(verdict) ? [] : [[verdict, index + 1] as const],
    );

    expect(acted.slice(0, MAX_RECOVERIES + 1)).toStrictEqual([
      [StallVerdict.Recover({ attempt: 1 }), 15],
      [StallVerdict.Recover({ attempt: 2 }), 15 + 30],
      [StallVerdict.Recover({ attempt: 3 }), 15 + 30 + 60],
      [StallVerdict.GiveUp(), 15 + 30 + 60 + 120],
    ]);
  });

  it("starts counting again once a recovered stream plays on", () => {
    const stalled = run(watching(STUCK_AT, 0), 0, 15, () => ({
      positionMs: STUCK_AT,
      intended: true,
      loading: false,
    }));

    expect(stalled.watch.attempts).toBe(1);

    const played = run(stalled.watch, 15 * SECOND, 30, (atMs) => ({
      positionMs: STUCK_AT + atMs - 15 * SECOND,
      intended: true,
      loading: false,
    }));

    expect(played.watch.attempts).toBe(0);

    const again = run(played.watch, 45 * SECOND, 15, () => ({
      positionMs: STUCK_AT + 30 * SECOND,
      intended: true,
      loading: false,
    }));

    expect(recoveries(again.verdicts)).toStrictEqual([1]);
  });

  it("keeps counting when a recovered stream stalls again before playing on", () => {
    const first = run(watching(STUCK_AT, 0), 0, 15, () => ({
      positionMs: STUCK_AT,
      intended: true,
      loading: false,
    }));

    const second = run(first.watch, 15 * SECOND, 40, (atMs) => ({
      positionMs: STUCK_AT + Math.min(atMs - 15 * SECOND, 2 * SECOND),
      intended: true,
      loading: false,
    }));

    expect(recoveries(second.verdicts)).toStrictEqual([2]);
  });

  it("gives a loading stream twice as long before recovering it", () => {
    const { verdicts } = run(watching(STUCK_AT, 0), 0, 30, () => ({
      positionMs: STUCK_AT,
      intended: true,
      loading: true,
    }));

    expect(verdicts.findIndex(StallVerdict.$is("Recover")) + 1).toBe(30);
  });

  it("never recovers before playback stood still for the first limit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: STALL_AFTER_MS / SECOND - 1 }),
        (positionMs, seconds) => {
          const { verdicts } = run(watching(positionMs, 0), 0, seconds, () => ({
            positionMs,
            intended: true,
            loading: false,
          }));

          return verdicts.every(StallVerdict.$is("Wait"));
        },
      ),
    );
  });
});
