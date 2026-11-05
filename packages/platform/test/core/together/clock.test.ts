import { ConvexError } from "convex/values";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { positionAt, startingClock, stepOf } from "../../../convex/core/together/clock";
import type { ControlOp, Step } from "../../../convex/core/together/clock";
import type { Clock } from "../../../convex/core/together/model";

const T0 = 1_700_000_000_000;

const playing = (positionAtAnchorMs: number, playbackRate = 1, revision = 3): Clock => ({
  status: "playing",
  positionAtAnchorMs,
  anchorServerTime: T0,
  playbackRate,
  revision,
});

const paused = (positionAtAnchorMs: number, revision = 3): Clock => ({
  ...playing(positionAtAnchorMs, 1, revision),
  status: "paused",
});

const moved = (step: Step): Clock => {
  if (step.kind !== "move") throw new Error(`expected a move, got ${step.kind}`);

  return step.clock;
};

const decodeCode = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }));

const codeOf = (run: () => Step): string => {
  try {
    run();

    return "accepted";
  } catch (error) {
    if (error instanceof ConvexError) return decodeCode(error.data).code;

    throw error;
  }
};

describe("the shared clock's position", () => {
  it("advances from its anchor at its rate while playing", () => {
    expect(positionAt(playing(10_000), T0 + 2_500)).toBe(12_500);
    expect(positionAt(playing(10_000, 1.5), T0 + 2_000)).toBe(13_000);
  });

  it("holds still while paused", () => {
    expect(positionAt(paused(10_000), T0 + 60_000)).toBe(10_000);
  });

  it("never runs backwards from an anchor a client sees as in its future", () => {
    expect(positionAt(playing(10_000), T0 - 500)).toBe(10_000);
  });

  it("starts paused at the beginning at revision 0", () => {
    expect(startingClock(T0)).toEqual(paused(0, 0));
  });
});

describe("moving the shared clock", () => {
  it("resumes where it paused, anchored at the server's now", () => {
    expect(moved(stepOf(paused(42_000), { kind: "play" }, T0 + 9_000))).toEqual({
      ...playing(42_000, 1, 4),
      anchorServerTime: T0 + 9_000,
    });
  });

  it("pauses at the live position", () => {
    const clock = moved(stepOf(playing(1_000, 2), { kind: "pause" }, T0 + 3_000));

    expect(clock).toMatchObject({ status: "paused", positionAtAnchorMs: 7_000, revision: 4 });
  });

  it("changes nothing when asked for what already holds, so two members never conflict", () => {
    expect(stepOf(playing(0), { kind: "play" }, T0)).toEqual({ kind: "same" });
    expect(stepOf(paused(0), { kind: "pause" }, T0)).toEqual({ kind: "same" });
    expect(stepOf(playing(0, 1.25), { kind: "rate", playbackRate: 1.25 }, T0)).toEqual({
      kind: "same",
    });
  });

  it("changes speed from the live position", () => {
    expect(
      moved(stepOf(playing(0), { kind: "rate", playbackRate: 1.5 }, T0 + 4_000)),
    ).toMatchObject({ positionAtAnchorMs: 4_000, playbackRate: 1.5, anchorServerTime: T0 + 4_000 });
  });

  it("refuses a seek or a skip asked of an older clock", () => {
    expect(stepOf(playing(0), { kind: "seek", positionMs: 5_000, revision: 2 }, T0)).toEqual({
      kind: "stale",
    });
    expect(stepOf(playing(0), { kind: "next", revision: 2 }, T0)).toEqual({ kind: "stale" });
  });

  it("seeks and skips against the clock the member saw", () => {
    expect(
      moved(stepOf(playing(0), { kind: "seek", positionMs: 5_000, revision: 3 }, T0 + 1)),
    ).toMatchObject({ positionAtAnchorMs: 5_000, status: "playing", revision: 4 });

    const skip = stepOf(paused(90_000), { kind: "next", revision: 3 }, T0);

    expect(skip).toMatchObject({ kind: "move", next: true });
    expect(moved(skip)).toMatchObject({ positionAtAnchorMs: 0, status: "paused" });
  });

  it.each<readonly [string, ControlOp]>([
    ["a negative position", { kind: "seek", positionMs: -1, revision: 3 }],
    ["a position that is not a number", { kind: "seek", positionMs: Number.NaN, revision: 3 }],
    ["a rate under half speed", { kind: "rate", playbackRate: 0.25 }],
    ["a rate over double speed", { kind: "rate", playbackRate: 3 }],
    ["a rate that is not a number", { kind: "rate", playbackRate: Number.NaN }],
  ])("refuses %s", (_name, op) => {
    expect(codeOf(() => stepOf(playing(0), op, T0))).toBe("invalid_args");
  });

  it("bumps the revision by one and keeps the position continuous on every move", () => {
    const op = fc.oneof(
      fc.constant<ControlOp>({ kind: "play" }),
      fc.constant<ControlOp>({ kind: "pause" }),
      fc
        .double({ min: 0.5, max: 2, noNaN: true })
        .map((playbackRate): ControlOp => ({ kind: "rate", playbackRate })),
    );

    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        op,
        (isPlaying, at, elapsed, move) => {
          const before = isPlaying ? playing(at) : paused(at);
          const now = T0 + elapsed;
          const step = stepOf(before, move, now);

          if (step.kind !== "move") return;

          expect(step.clock.revision).toBe(before.revision + 1);
          expect(step.clock.anchorServerTime).toBe(now);
          expect(positionAt(step.clock, now)).toBeCloseTo(positionAt(before, now), 6);
        },
      ),
    );
  });
});
