import { describe, expect, it } from "vitest";

import { asTrackId } from "./models";
import { startPlay } from "./start-play";
import type { PlayOptions, PlaySource } from "./start-play";

const songs = ["a", "b", "c"].map((id) => ({ id: asTrackId(id) }));

/**
 * A player that records each call, and a load of the songs held until the test lets it answer,
 * like an album's pages still on their way.
 */
const setup = (shuffle: boolean) => {
  const calls: Array<string> = [];
  const held = Promise.withResolvers<typeof songs>();

  const player = {
    shuffle,
    primeOutput: () => {
      calls.push("prime");
    },
    setShuffle: async (on: boolean) => {
      calls.push(`shuffle:${on}`);
    },
    playTracks: async (ids: ReadonlyArray<string>) => {
      calls.push(`play:${ids.join(",")}`);
    },
  };

  /** Starts the load, as a tap does before it hands the songs on. */
  const load = (): Promise<typeof songs> => {
    calls.push("load");

    return held.promise;
  };

  return {
    calls,
    player: () => player,
    load,
    answer: () => {
      held.resolve(songs);
    },
  };
};

/**
 * Each way a tap starts songs, and what runs synchronously inside it: the load's request, if any,
 * then the priming, and none of the core calls that follow the await.
 */
const taps: ReadonlyArray<{
  readonly name: string;
  readonly loads: boolean;
  readonly shuffleOn: boolean;
  readonly options: PlayOptions;
  readonly inTap: ReadonlyArray<string>;
}> = [
  {
    name: "a song row, a search result, a playlist",
    loads: false,
    shuffleOn: false,
    options: { index: 1 },
    inTap: ["prime"],
  },
  {
    name: "Shuffle while shuffle is off",
    loads: false,
    shuffleOn: false,
    options: { shuffle: true },
    inTap: ["prime"],
  },
  {
    name: "Play while shuffle is on",
    loads: false,
    shuffleOn: true,
    options: { shuffle: false },
    inTap: ["prime"],
  },
  {
    name: "an album or artist card",
    loads: true,
    shuffleOn: false,
    options: { shuffle: false },
    inTap: ["load", "prime"],
  },
  {
    name: "Shuffle all, Shuffle liked songs",
    loads: true,
    shuffleOn: false,
    options: { shuffle: true },
    inTap: ["load", "prime"],
  },
];

describe("startPlay", () => {
  it.each(taps)("primes the output inside the tap before any await: $name", async (tap) => {
    const { calls, player, load, answer } = setup(tap.shuffleOn);
    const source: PlaySource = tap.loads ? load() : songs;

    const started = startPlay(player, source, tap.options);

    expect(calls).toStrictEqual(tap.inTap);

    answer();
    await started;

    expect(calls.at(-1)).toBe("play:a,b,c");
    expect(calls.filter((call) => call === "prime")).toHaveLength(1);
  });

  it("turns shuffle on before playing, and plays nothing for an empty list", async () => {
    const { calls, player } = setup(false);

    await startPlay(player, songs, { shuffle: true });
    await startPlay(player, [], {});

    expect(calls).toStrictEqual(["prime", "shuffle:true", "play:a,b,c", "prime"]);
  });
});
