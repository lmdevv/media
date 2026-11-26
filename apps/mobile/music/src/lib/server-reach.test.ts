import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ANSWERING, isLost, LOST_AFTER, nextCheck, observe, reachOf } from "./server-reach";
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

const observation = fc.constantFrom<Observation>("answered", "failed", "doubted");

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
    expect(nextCheck(doubted, true)).toBe("now");
  });

  it("drops what lands with evidence older than the newest applied", () => {
    fc.assert(
      fc.property(landings, observation, fc.integer({ min: 0, max: 50 }), (list, late, at) => {
        const state = applied(list);

        fc.pre(at <= state.newest);
        expect(observe(state, late, at)).toBe(state);
      }),
    );
  });

  it("drops a check's answer once a later check answered, whichever lands first", () => {
    const state = applied([
      ["answered", 2],
      ["failed", 1],
    ]);

    expect(state).toEqual({ failures: 0, doubted: false, newest: 2 });
  });

  it("always applies the newest evidence", () => {
    fc.assert(
      fc.property(landings, observation, (list, last) => {
        const state = applied(list);
        const next = observe(state, last, state.newest + 1);

        expect(next.newest).toBe(state.newest + 1);
        expect(next.doubted).toBe(last === "doubted");
        const failures = { answered: 0, failed: state.failures + 1, doubted: state.failures };

        expect(next.failures).toBe(failures[last]);
      }),
    );
  });
});

describe("nextCheck", () => {
  it("sends no check while nothing needs the server, whatever it learned", () => {
    fc.assert(
      fc.property(landings, (list) => {
        expect(nextCheck(applied(list), false)).toBe("none");
      }),
    );
  });

  it("checks at once after a doubt, soon after a failure, and not at all while it answers", () => {
    expect(nextCheck(applied([["doubted", 1]]), true)).toBe("now");
    expect(nextCheck(applied([["failed", 1]]), true)).toBe("soon");
    expect(nextCheck(applied([["answered", 1]]), true)).toBe("none");
    expect(nextCheck(ANSWERING, true)).toBe("none");
  });
});
