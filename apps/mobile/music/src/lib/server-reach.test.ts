import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ANSWERING,
  CLOSED_RECHECK_MS,
  isLost,
  LOST_AFTER,
  nextCheck,
  observe,
  reachOf,
  RECHECK_MS,
  SETTLE_MS,
} from "./server-reach";
import type { Observation, Reachability } from "./server-reach";

const connected = { offlinePhase: false, socketLost: false, stalled: false };

describe("reachOf", () => {
  it("keeps the screens online while only a request is slow, and lets the notice say so", () => {
    expect(reachOf({ ...connected, stalled: true })).toEqual({
      reach: "online",
      notice: "reconnecting",
    });
  });

  it("calls a lost socket reconnecting for screens and notice alike", () => {
    expect(reachOf({ ...connected, socketLost: true, stalled: true })).toEqual({
      reach: "reconnecting",
      notice: "reconnecting",
    });
  });

  it("stays offline for a launch that never reached the server", () => {
    expect(reachOf({ offlinePhase: true, socketLost: true, stalled: true })).toEqual({
      reach: "offline",
      notice: "offline",
    });
  });

  it("is online with the socket up and nothing waiting", () => {
    expect(reachOf(connected)).toEqual({ reach: "online", notice: "online" });
  });
});

const observation = fc.constantFrom<Observation>(
  "answered",
  "failed",
  "doubted",
  "coreAnswered",
  "coreDoubted",
);

/** Observations in the order they land, each with the evidence its request or event took. */
const landings = fc.array(fc.tuple(observation, fc.integer({ min: 1, max: 50 })), {
  maxLength: 20,
});

const applied = (list: ReadonlyArray<readonly [Observation, number]>): Reachability =>
  list.reduce((state, [seen, at]) => observe(state, seen, at), ANSWERING);

describe("observe", () => {
  it("calls the server gone after LOST_AFTER unanswered checks in a row, and back at one answer", () => {
    const failed = applied([
      ["failed", 1],
      ["failed", 2],
    ]);

    expect(LOST_AFTER).toBe(2);
    expect(isLost(applied([["failed", 1]]))).toBe(false);
    expect(isLost(failed)).toBe(true);
    expect(isLost(observe(failed, "answered", 3))).toBe(false);
  });

  it("keeps a doubt from counting as a failure: only a check decides", () => {
    const doubted = applied([
      ["doubted", 1],
      ["doubted", 2],
      ["doubted", 3],
    ]);

    expect(isLost(doubted)).toBe(false);
    expect(nextCheck(doubted, true, true)).toBe(SETTLE_MS);
  });

  it("lets the core's answers settle only doubts about the core, never the media server's", () => {
    fc.assert(
      fc.property(landings, fc.integer({ min: 1, max: 20 }), (list, answers) => {
        const state = applied(list);
        const top = Math.max(state.checked, state.core);

        const answered = Array.from({ length: answers }, (_, index) => index).reduce(
          (current, index) => observe(current, "coreAnswered", top + 1 + index),
          state,
        );

        expect(answered.failures).toBe(state.failures);
        expect(answered.mediaDoubt).toBe(state.mediaDoubt);
        expect(answered.coreDoubt).toBeNull();
      }),
    );
  });

  it("drops a check's answer once a later check answered, whichever lands first", () => {
    const state = applied([
      ["answered", 2],
      ["failed", 1],
    ]);

    expect(state).toEqual({ ...ANSWERING, checked: 2 });
  });

  it("keeps a doubt raised after a check went out when that check answers", () => {
    const state = applied([
      ["doubted", 3],
      ["coreDoubted", 4],
      ["answered", 2],
    ]);

    expect(state.mediaDoubt).toBe(3);
    expect(state.coreDoubt).toBe(4);
    expect(observe(state, "failed", 5)).toMatchObject({
      failures: 1,
      mediaDoubt: null,
      coreDoubt: null,
    });
  });
});

describe("nextCheck", () => {
  it("sends no check while nothing needs the server, whatever it learned", () => {
    fc.assert(
      fc.property(landings, (list) => {
        expect(nextCheck(applied(list), false, false)).toBeNull();
      }),
    );
  });

  it("checks a settle after a doubt, a recheck after a failure, and never while it answers", () => {
    expect(nextCheck(applied([["doubted", 1]]), true, true)).toBe(SETTLE_MS);
    expect(nextCheck(applied([["failed", 1]]), true, true)).toBe(RECHECK_MS);
    expect(nextCheck(applied([["answered", 1]]), true, true)).toBeNull();
    expect(nextCheck(ANSWERING, true, true)).toBeNull();
  });

  it("keeps checking while the socket is closed, since the core can't say the server went away", () => {
    expect(nextCheck(applied([["answered", 1]]), true, false)).toBe(CLOSED_RECHECK_MS);
    expect(nextCheck(applied([["doubted", 1]]), true, false)).toBe(SETTLE_MS);
    expect(nextCheck(applied([["failed", 1]]), true, false)).toBe(RECHECK_MS);
  });
});
