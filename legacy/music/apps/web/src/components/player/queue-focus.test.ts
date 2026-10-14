import { describe, expect, it } from "vitest";

import { FOCUS_WINDOW_MS, focusMove } from "./queue-focus";

const removal = { position: 1, trackId: "b", countBefore: 1, landedAt: 10_000 };

describe("focusMove", () => {
  it("moves focus once the removed song is gone from the list", () => {
    expect(focusMove(removal, { now: 10_100, trackIds: ["a", "c"], focusFree: true })).toBe("move");
  });

  it("waits while the list still shows the song, even if it changed for another reason", () => {
    // Another device added a song while the removal was landing: the length didn't drop.
    expect(
      focusMove(removal, { now: 10_100, trackIds: ["a", "b", "c", "d"], focusFree: true }),
    ).toBe("wait");
  });

  it("counts a song queued twice, so removing one copy is seen", () => {
    const twice = { ...removal, countBefore: 2 };

    expect(focusMove(twice, { now: 10_100, trackIds: ["a", "b", "c"], focusFree: true })).toBe(
      "move",
    );
  });

  it("drops a move that comes too late or would take focus from elsewhere", () => {
    expect(
      focusMove(removal, {
        now: 10_000 + FOCUS_WINDOW_MS + 1,
        trackIds: ["a", "c"],
        focusFree: true,
      }),
    ).toBe("drop");
    expect(focusMove(removal, { now: 10_100, trackIds: ["a", "c"], focusFree: false })).toBe(
      "drop",
    );
  });
});
