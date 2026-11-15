import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NEXT_EPISODE_COUNTDOWN_MS, creditsStartMs } from "./clock";
import type { SessionClock } from "./clock";
import { sessionNext } from "./session-next";
import type { NextInput } from "./session-next";
import { EpochMillis } from "./units";

const NOW = 1_760_000_000_000;

const DURATION_MS = 600_000;

const NEXT = "movies:episode:2";

const MOVIE = "movies:title:9";

const at = (positionMs: number, status: SessionClock["status"] = "playing"): SessionClock => ({
  status,
  positionAtAnchorMs: positionMs,
  anchorServerTime: NOW,
  playbackRate: 1,
  revision: 7,
});

const input = (overrides: Partial<NextInput>): NextInput => ({
  clock: at(0),
  serverNow: EpochMillis.make(NOW),
  durationMs: DURATION_MS,
  nextKey: NEXT,
  headKey: null,
  queued: false,
  hosting: true,
  mayControl: true,
  creditsWatched: false,
  ...overrides,
});

const credits = creditsStartMs(DURATION_MS);

describe("sessionNext", () => {
  it("does nothing before the credits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: credits - 1 }), fc.boolean(), (position, hosting) => {
        expect(sessionNext(input({ clock: at(position), hosting }))).toStrictEqual({
          countdown: null,
          step: null,
        });
      }),
    );
  });

  it("has the host queue the next episode first once the credits start", () => {
    expect(sessionNext(input({ clock: at(credits) })).step).toBe("queue");
    expect(sessionNext(input({ clock: at(credits), headKey: MOVIE, queued: true })).step).toBe(
      "queue",
    );
  });

  it("counts every member down once the next episode is queued first", () => {
    const queuedFirst = { headKey: NEXT, queued: true };

    expect(
      sessionNext(input({ clock: at(credits + 4_000), ...queuedFirst, hosting: false })),
    ).toStrictEqual({
      countdown: {
        countdownMs: NEXT_EPISODE_COUNTDOWN_MS - 4_000,
        canPlayNow: true,
        canWatchCredits: false,
      },
      step: null,
    });

    expect(
      sessionNext(input({ clock: at(credits), ...queuedFirst, hosting: false, mayControl: false }))
        .countdown?.canPlayNow,
    ).toBe(false);
  });

  it("moves on when the countdown ends", () => {
    expect(
      sessionNext(
        input({ clock: at(credits + NEXT_EPISODE_COUNTDOWN_MS), headKey: NEXT, queued: true }),
      ),
    ).toStrictEqual({ countdown: null, step: "next" });
  });

  it("does not queue again after the host watched the credits, and holds at the end", () => {
    expect(sessionNext(input({ clock: at(credits), creditsWatched: true })).step).toBeNull();
    expect(sessionNext(input({ clock: at(DURATION_MS), creditsWatched: true })).step).toBe("pause");
  });

  it("plays what is queued at the end of a movie, and holds at the end of the last", () => {
    const film = input({ nextKey: null });

    expect(
      sessionNext({ ...film, clock: at(DURATION_MS), headKey: MOVIE, queued: true }).step,
    ).toBe("next");
    expect(sessionNext({ ...film, clock: at(DURATION_MS), queued: true }).step).toBe("next");
    expect(sessionNext({ ...film, clock: at(DURATION_MS) }).step).toBe("pause");
    expect(sessionNext({ ...film, clock: at(DURATION_MS, "paused") }).step).toBeNull();
  });

  it("leaves the steps to the host", () => {
    fc.assert(
      fc.property(fc.integer({ min: credits, max: DURATION_MS + 60_000 }), (position) => {
        expect(
          sessionNext(input({ clock: at(position), hosting: false, headKey: MOVIE, queued: true }))
            .step,
        ).toBeNull();
      }),
    );
  });

  it("decides nothing before the server's time or the item's length is known", () => {
    expect(sessionNext(input({ clock: at(credits), serverNow: null }))).toStrictEqual({
      countdown: null,
      step: null,
    });
    expect(sessionNext(input({ clock: at(credits), durationMs: null })).step).toBeNull();
  });
});
