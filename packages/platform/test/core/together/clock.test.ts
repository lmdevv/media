import { ConvexError } from "convex/values";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CARRY_MAX_MS,
  FIRST_BY_MS,
  carriedPast,
  positionAt,
  reachedAt,
  startingClock,
  stepOf,
} from "../../../convex/core/together/clock";
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

/**
 * A skip's carry: the length of the item it leaves, a next item whose length the core does not
 * know, queued first a minute before the anchor, well before any end.
 */
const leaving = (length: number) => ({ leavingMs: length, nextMs: null, firstSince: T0 - 60_000 });

/** Where a skip 10.4 seconds after the anchor starts the next item, the one it leaves `length` long. */
const skipStart = (clock: Clock, length: number | null): number =>
  moved(
    stepOf(
      clock,
      { kind: "next", revision: 3 },
      T0 + 10_400,
      length === null ? null : leaving(length),
    ),
  ).positionAtAnchorMs;

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

  it("changes nothing for a play or rate that already holds, so two members never conflict", () => {
    expect(stepOf(playing(0), { kind: "play" }, T0)).toEqual({ kind: "same" });
    expect(stepOf(playing(0, 1.25), { kind: "rate", playbackRate: 1.25 }, T0)).toEqual({
      kind: "same",
    });
  });

  it("gives a pause of a paused clock a new revision at the same position", () => {
    expect(moved(stepOf(paused(42_000), { kind: "pause" }, T0 + 5_000))).toEqual({
      ...paused(42_000, 4),
      anchorServerTime: T0 + 5_000,
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

  it("refuses a play or pause a client decided against an older clock, or a newer one", () => {
    expect(stepOf(paused(42_000), { kind: "play", revision: 2 }, T0)).toEqual({ kind: "stale" });
    expect(stepOf(playing(0), { kind: "play", revision: 2 }, T0)).toEqual({ kind: "stale" });
    expect(stepOf(playing(0), { kind: "pause", revision: 2 }, T0)).toEqual({ kind: "stale" });
    expect(stepOf(paused(42_000), { kind: "pause", revision: 4 }, T0)).toEqual({ kind: "stale" });
  });

  it("decides a play or pause at the clock's own revision as one that carries none", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        fc.constantFrom("play", "pause"),
        (isPlaying, at, elapsed, kind) => {
          const before = isPlaying ? playing(at) : paused(at);
          const now = T0 + elapsed;

          expect(stepOf(before, { kind, revision: before.revision }, now)).toEqual(
            stepOf(before, { kind }, now),
          );
        },
      ),
    );
  });

  it("seeks and skips against the clock the member saw", () => {
    expect(
      moved(stepOf(playing(0), { kind: "seek", positionMs: 5_000, revision: 3 }, T0 + 1)),
    ).toMatchObject({ positionAtAnchorMs: 5_000, status: "playing", revision: 4 });

    const skip = stepOf(paused(90_000), { kind: "next", revision: 3 }, T0);

    expect(skip).toMatchObject({ kind: "move", next: true });
    expect(moved(skip)).toMatchObject({ positionAtAnchorMs: 0, status: "paused" });
  });

  it("starts the next song as far in as the clock played past the end of the one it leaves", () => {
    // A 3-minute song that has played 180.4 seconds: players moved on 400 ms ago, by themselves.
    const skip = stepOf(
      playing(170_000),
      { kind: "next", revision: 3 },
      T0 + 10_400,
      leaving(180_000),
    );

    expect(moved(skip)).toMatchObject({
      status: "playing",
      positionAtAnchorMs: 400,
      anchorServerTime: T0 + 10_400,
      revision: 4,
    });
    expect(
      moved(
        stepOf(playing(170_000, 2), { kind: "next", revision: 3 }, T0 + 5_500, leaving(180_000)),
      ),
    ).toMatchObject({ positionAtAnchorMs: 1_000 });
  });

  it("starts the next item from its start before the end, while paused, or at an unknown length", () => {
    expect(skipStart(playing(100_000), 180_000)).toBe(0);
    expect(skipStart(paused(190_000), 180_000)).toBe(0);
    expect(skipStart(playing(170_000), null)).toBe(0);
  });

  it("starts the next item from its start once the clock ran far past the end, or past its own", () => {
    // 20.4 seconds past the end of a 3-minute song, as a session nobody moved on.
    expect(carriedPast(playing(170_000), T0 + 30_400, leaving(180_000))).toBe(0);

    // 5 seconds past the end, into a next song only 4 seconds long.
    const into = (nextMs: number) =>
      carriedPast(playing(179_000), T0 + 6_000, { ...leaving(180_000), nextMs });

    expect(into(4_000)).toBe(0);
    expect(into(6_000)).toBe(5_000);
  });

  it("carries only into the entry queued first long enough before the end to be preloaded", () => {
    // Anchored 10 seconds before the end of a 3-minute song; the skip comes 400 ms after the end.
    const clock = playing(170_000);
    const end = T0 + 10_000;

    const queuedFirstAt = (firstSince: number) =>
      carriedPast(clock, end + 400, { ...leaving(180_000), firstSince });

    expect(reachedAt(clock, 180_000)).toBe(end);
    expect(queuedFirstAt(T0 - 60_000)).toBe(400);
    expect(queuedFirstAt(end - FIRST_BY_MS)).toBe(400);

    // First only in the last seconds before the end, or since it: an add in front, a removal of
    // the entry before it, or a move, which players had no time to preload.
    expect(queuedFirstAt(end - FIRST_BY_MS + 1)).toBe(0);
    expect(queuedFirstAt(end)).toBe(0);
    expect(queuedFirstAt(end + 400)).toBe(0);
  });

  it("carries nothing once a move put the clock at or past the end", () => {
    // A seek there, or a play after a pause there: the clock did not run into the end on its own.
    expect(carriedPast(playing(180_000), T0 + 400, leaving(180_000))).toBe(0);
    expect(carriedPast(playing(181_000), T0 + 400, leaving(180_000))).toBe(0);
    expect(reachedAt(playing(180_000), 180_000)).toBeNull();
    expect(reachedAt(paused(170_000), 180_000)).toBeNull();
  });

  it("carries a skip's start a little past the end, into what was queued first then, and never below 0", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 600_000 }),
        fc.constantFrom(0.5, 0.95, 1, 1.05, 2),
        fc.integer({ min: 0, max: 600_000 }),
        fc.integer({ min: 1, max: 600_000 }),
        fc.option(fc.integer({ min: 1, max: 600_000 })),
        // When the entry got to be queued first, from its song's end, around the time players
        // take to preload it, or anywhere.
        fc.oneof(
          fc.integer({ min: -2 * FIRST_BY_MS, max: FIRST_BY_MS }),
          fc.integer({ min: -600_000, max: 600_000 }),
        ),
        (isPlaying, at, rate, elapsed, length, next, firstFromEnd) => {
          const before = isPlaying ? playing(at, rate) : paused(at);
          const now = T0 + elapsed;

          // When the clock ran into the end on its own, playing since its anchor before it.
          const endedAt = isPlaying && at < length ? T0 + (length - at) / rate : null;
          const firstSince = (endedAt ?? T0) + firstFromEnd;
          const carry = { leavingMs: length, nextMs: next, firstSince };
          const start = carriedPast(before, now, carry);
          const past = positionAt(before, now) - length;

          const carries =
            endedAt !== null &&
            firstSince <= endedAt - FIRST_BY_MS &&
            past > 0 &&
            past <= CARRY_MAX_MS &&
            (next ?? past + 1) > past;

          expect(start).toBeGreaterThanOrEqual(0);
          expect(start).toBe(carries ? past : 0);
          expect(moved(stepOf(before, { kind: "next", revision: 3 }, now, carry))).toMatchObject({
            positionAtAnchorMs: start,
            status: before.status,
          });
        },
      ),
    );
  });

  it.each<readonly [string, ControlOp]>([
    ["a negative position", { kind: "seek", positionMs: -1, revision: 3 }],
    ["a position that is not a number", { kind: "seek", positionMs: Number.NaN, revision: 3 }],
    ["a negative position asked of an older clock", { kind: "seek", positionMs: -1, revision: 2 }],
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
