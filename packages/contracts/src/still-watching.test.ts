import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ASK_ON_JUMP,
  CLOSE_AFTER_MS,
  WATCHING,
  autoplayDue,
  closesInMs,
  unanswered,
  viewerActed,
} from "./still-watching";
import type { StillWatching } from "./still-watching";

const NOW = 1_760_000_000_000;

/** Runs autoplay's countdown to its end `times` times with no input. */
const jumpsFrom = (start: StillWatching, times: number): ReadonlyArray<boolean> => {
  const plays: Array<boolean> = [];
  let watching = start;

  for (let jump = 0; jump < times; jump += 1) {
    const step = autoplayDue(watching, NOW + jump);

    plays.push(step.play);
    watching = step.next;
  }

  return plays;
};

describe("autoplayDue", () => {
  it("plays two episodes in a row, then asks on the third jump", () => {
    expect(ASK_ON_JUMP).toBe(3);
    expect(jumpsFrom(WATCHING, 3)).toEqual([true, true, false]);
  });

  it("asks from the moment the countdown ends", () => {
    const asked = autoplayDue({ state: "watching", jumps: 2 }, NOW);

    expect(asked).toEqual({ play: false, next: { state: "asking", since: NOW } });
  });

  it("plays nothing while the question waits", () => {
    const asking: StillWatching = { state: "asking", since: NOW };

    expect(autoplayDue(asking, NOW + 5_000)).toEqual({ play: false, next: asking });
  });

  it("never plays more than two jumps in a row without input", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (times) => {
        const plays = jumpsFrom(WATCHING, times);

        expect(plays.filter(Boolean).length).toBeLessThanOrEqual(ASK_ON_JUMP - 1);
      }),
    );
  });
});

describe("viewerActed", () => {
  it("resets the count", () => {
    expect(viewerActed({ state: "watching", jumps: 2 })).toEqual(WATCHING);
    expect(jumpsFrom(viewerActed({ state: "watching", jumps: 2 }), 2)).toEqual([true, true]);
  });

  it("leaves the question to its buttons", () => {
    const asking: StillWatching = { state: "asking", since: NOW };

    expect(viewerActed(asking)).toBe(asking);
  });
});

describe("unanswered", () => {
  const asking: StillWatching = { state: "asking", since: NOW };

  it("closes after two minutes with no answer", () => {
    expect(CLOSE_AFTER_MS).toBe(120_000);
    expect(unanswered(asking, NOW + CLOSE_AFTER_MS - 1)).toBe(false);
    expect(unanswered(asking, NOW + CLOSE_AFTER_MS)).toBe(true);
    expect(unanswered(WATCHING, NOW + CLOSE_AFTER_MS * 10)).toBe(false);
  });

  it("counts down to the close", () => {
    expect(closesInMs(asking, NOW + 30_000)).toBe(90_000);
    expect(closesInMs(asking, NOW + CLOSE_AFTER_MS * 2)).toBe(0);
    expect(closesInMs(WATCHING, NOW)).toBeNull();
  });
});
