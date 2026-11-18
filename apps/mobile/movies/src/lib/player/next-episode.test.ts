import { Milliseconds } from "@media/contracts/units";
import { describe, expect, it } from "vitest";

import { episodeLine, inCredits, nextEpisodeFacts, secondsLeft } from "./next-episode";

const at = (positionSeconds: number, playing = true, ended = false) =>
  inCredits({ positionSeconds, durationSeconds: 3000, playing, ended });

describe("inCredits", () => {
  it("opens in the last 30 seconds while playing", () => {
    expect(at(2969)).toBe(false);
    expect(at(2970)).toBe(true);
    expect(at(2990, false)).toBe(false);
  });

  it("opens at the end, playing or not", () => {
    expect(at(3000, false, true)).toBe(true);
  });

  it("uses the last tenth of a short episode", () => {
    expect(
      inCredits({ positionSeconds: 89, durationSeconds: 100, playing: true, ended: false }),
    ).toBe(false);
    expect(
      inCredits({ positionSeconds: 90, durationSeconds: 100, playing: true, ended: false }),
    ).toBe(true);
  });

  it("waits for a duration", () => {
    expect(inCredits({ positionSeconds: 0, durationSeconds: 0, playing: true, ended: true })).toBe(
      false,
    );
  });
});

describe("the countdown", () => {
  it("counts whole seconds up", () => {
    expect(secondsLeft(10_000)).toBe(10);
    expect(secondsLeft(7_001)).toBe(8);
    expect(secondsLeft(-5)).toBe(0);
  });

  it("describes the next episode", () => {
    expect(
      nextEpisodeFacts({
        seasonNumber: 2,
        episodeNumber: 4,
        runtimeMs: Milliseconds.make(49 * 60_000),
      }),
    ).toBe("S2, E4 · 49m");
    expect(nextEpisodeFacts({ seasonNumber: 1, episodeNumber: 3, runtimeMs: null })).toBe("S1, E3");
  });
});

describe("episodeLine", () => {
  it("names an episode by season, number, and name", () => {
    expect(episodeLine({ seasonNumber: 1, episodeNumber: 2, name: "Half Loop" })).toBe(
      "S1, E2 · Half Loop",
    );
  });
});
