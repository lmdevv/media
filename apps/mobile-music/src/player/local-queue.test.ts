import type { QueueState } from "@media/player/playback-controller";
import { nextIndex } from "@media/player/queue-order";
import { describe, expect, it } from "vitest";

import type { Track } from "@/lib/models";
import { trackOf } from "@/lib/test-fixtures";

import {
  addLocal,
  clearLocal,
  handBack,
  jumpLocal,
  moveLocal,
  playingView,
  playLocal,
  recordPlay,
  removeLocal,
  repeatLocal,
  seedLocal,
  shuffleLocal,
} from "./local-queue";
import type { LocalQueue } from "./local-queue";

const one = trackOf("Safe from Harm");

const two = trackOf("One Love");

const three = trackOf("Blue Lines");

const empty = seedLocal<Track>(null, () => null);

/** Keeps each item where it is: a shuffle that leaves what it is given in order. */
const inOrder = (): number => 0.999;

const titles = (queue: LocalQueue<Track>): ReadonlyArray<string> =>
  queue.state.entries.map((entry) => entry.track.title);

/** The songs a queue plays from its entry playing until it stops, repeat off. */
const playedOut = (state: QueueState<Track>): ReadonlyArray<string> => {
  const played: Array<string> = [];

  for (
    let at: number | null = state.entries.findIndex((entry) => entry.itemId === state.current);
    at !== null && at !== -1;
    at = nextIndex(at, state.entries.length, "off")
  ) {
    played.push(state.entries[at]?.track.title ?? "");
  }

  return played;
};

/** A server queue of six songs, the second and fifth of them downloaded, playing the second. */
const sixSongs = () => {
  const songs = ["A", "B", "C", "D", "E", "F"].map((title) => trackOf(title));

  const server: QueueState<Track> = {
    entries: songs.map((track, index) => ({ itemId: `s${String(index)}`, autoplay: false, track })),
    current: "s1",
    shuffle: false,
    repeat: "off",
    autoplay: false,
  };

  const downloaded = new Set<string>([songs[1]?.id ?? "", songs[4]?.id ?? ""]);

  const copyOf = (id: string): Track | null =>
    downloaded.has(id) ? (songs.find((song) => song.id === id) ?? null) : null;

  return { songs, held: seedLocal(server, copyOf) };
};

describe("seedLocal", () => {
  it("keeps every one of the server's entries, and plays its entry when this phone holds it", () => {
    const server: QueueState<Track> = {
      entries: [
        { itemId: "a", autoplay: false, track: one },
        { itemId: "b", autoplay: false, track: two },
        { itemId: "c", autoplay: true, track: three },
      ],
      current: "c",
      shuffle: true,
      repeat: "all",
      autoplay: true,
    };

    const copy = { ...three, artUrl: "file:///art/c" };
    const held = seedLocal(server, (id) => (id === one.id ? one : id === three.id ? copy : null));

    expect(held.state.entries.map((entry) => entry.itemId)).toEqual(["a", "b", "c"]);
    expect(held.state.entries[2]?.track.artUrl).toBe("file:///art/c");
    expect(held.state).toMatchObject({ current: "c", shuffle: true, repeat: "all" });
    expect(held.changed).toBe(false);
    expect(playingView(held).entries.map((entry) => entry.itemId)).toEqual(["a", "c"]);
  });

  it("plays the next entry this phone holds when it doesn't hold the server's", () => {
    const { held } = sixSongs();
    const server = { ...held.state, current: "s2" };

    expect(
      seedLocal(server, (id) => (held.state.entries[4]?.track.id === id ? one : null)).state
        .current,
    ).toBe("s4");
    expect(seedLocal(server, () => null).state.current).toBeNull();
  });
});

describe("the phone's own queue", () => {
  it("plays songs from the one picked, with ids it has not used", () => {
    const queue = playLocal(empty, [one, two, three], 1, inOrder);

    expect(titles(queue)).toEqual(["Safe from Harm", "One Love", "Blue Lines"]);
    expect(queue.state.current).toBe("local-2");
    expect(playLocal(queue, [one], 0, inOrder).state.current).toBe("local-4");
    expect(queue.changed).toBe(true);
  });

  it("plays every song shuffled, the one picked first and the rest shuffled behind it", () => {
    const shuffled = shuffleLocal(empty, true, inOrder);
    const queue = playLocal(shuffled, [one, two, three], 1, inOrder);

    expect(queue.state.current).toBe("local-2");
    expect(playedOut(playingView(queue))).toEqual(["One Love", "Safe from Harm", "Blue Lines"]);
    expect(titles(shuffleLocal(queue, false, inOrder))).toEqual([
      "Safe from Harm",
      "One Love",
      "Blue Lines",
    ]);
  });

  it("jumps, adds next or last, removes, moves, and clears after the song playing", () => {
    const queue = playLocal(empty, [one, two], 0, inOrder);

    expect(jumpLocal(queue, "local-2").state.current).toBe("local-2");
    expect(jumpLocal(queue, "nowhere")).toBe(queue);
    expect(titles(addLocal(queue, [three], true))).toEqual([
      "Safe from Harm",
      "Blue Lines",
      "One Love",
    ]);
    expect(titles(addLocal(queue, [three], false))).toEqual([
      "Safe from Harm",
      "One Love",
      "Blue Lines",
    ]);

    const removed = removeLocal(queue, "local-1");

    expect(titles(removed)).toEqual(["One Love"]);
    expect(removed.state.current).toBe("local-2");
    expect(titles(moveLocal(queue, "local-1", "local-2"))).toEqual(["One Love", "Safe from Harm"]);
    expect(titles(moveLocal(queue, "local-2", undefined))).toEqual(["One Love", "Safe from Harm"]);
    expect(titles(clearLocal(queue))).toEqual(["Safe from Harm"]);
  });

  it("adds songs to the end before the ones autoplay added", () => {
    const server: QueueState<Track> = {
      entries: [
        { itemId: "a", autoplay: false, track: one },
        { itemId: "b", autoplay: true, track: two },
      ],
      current: "a",
      shuffle: false,
      repeat: "off",
      autoplay: true,
    };

    const held = seedLocal(server, (id) => (id === three.id ? null : one));

    expect(addLocal(held, [three], false).state.entries.map((entry) => entry.itemId)).toEqual([
      "a",
      "local-1",
      "b",
    ]);
  });

  it("plays the next entry it holds after the one playing is removed, the others staying", () => {
    const { held } = sixSongs();
    const removed = removeLocal(held, "s1");

    expect(removed.state.entries.map((entry) => entry.itemId)).toEqual([
      "s0",
      "s2",
      "s3",
      "s4",
      "s5",
    ]);
    expect(removed.state.current).toBe("s4");
  });

  it("shuffles every entry but the one playing behind it, autoplay's last, and puts them back", () => {
    const server: QueueState<Track> = {
      entries: [
        { itemId: "a", autoplay: false, track: one },
        { itemId: "b", autoplay: false, track: two },
        { itemId: "c", autoplay: false, track: three },
        { itemId: "d", autoplay: true, track: trackOf("Unfinished Sympathy") },
      ],
      current: "b",
      shuffle: false,
      repeat: "off",
      autoplay: true,
    };

    const held = seedLocal(
      server,
      (id) => server.entries.find((e) => e.track.id === id)?.track ?? null,
    );

    const shuffled = shuffleLocal(held, true, inOrder);

    expect(shuffled.state.entries.map((entry) => entry.itemId)).toEqual(["b", "a", "c", "d"]);
    expect(shuffled.state.shuffle).toBe(true);
    expect(
      shuffleLocal(shuffled, false, inOrder).state.entries.map((entry) => entry.itemId),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a move made while shuffled once shuffle turns off", () => {
    const queue = shuffleLocal(playLocal(empty, [one, two, three], 0, inOrder), true, inOrder);
    const moved = moveLocal(queue, "local-3", undefined);

    expect(titles(shuffleLocal(moved, false, inOrder))).toEqual([
      "Blue Lines",
      "Safe from Harm",
      "One Love",
    ]);
  });

  it("keeps its plays for the server's history", () => {
    expect(recordPlay(empty, one.id, 42).plays).toEqual([{ trackId: one.id, playedAt: 42 }]);
  });
});

describe("handBack", () => {
  it("hands back a repeat chosen here and the entry playing, leaving the server's songs alone", () => {
    const { held } = sixSongs();
    const repeated = repeatLocal(jumpLocal(held, "s4"), "one");

    expect(repeated.changed).toBe(false);
    expect(handBack(repeated, false)).toEqual([
      { kind: "jump", itemId: "s4" },
      { kind: "repeat", mode: "one" },
    ]);
  });

  it("hands back shuffle turned here after the entry playing, so the server shuffles around it", () => {
    const { held } = sixSongs();
    const shuffled = shuffleLocal(held, true, inOrder);

    expect(shuffled.changed).toBe(false);
    expect(handBack(shuffled, false)).toEqual([
      { kind: "jump", itemId: "s1" },
      { kind: "shuffle", on: true },
    ]);
  });

  it("sends nothing but the entry playing when only songs played on", () => {
    const { held } = sixSongs();

    expect(handBack(jumpLocal(held, "s4"), false)).toEqual([{ kind: "jump", itemId: "s4" }]);
    expect(handBack(empty, false)).toEqual([]);
  });

  it("hands back an edited queue whole, the songs this phone has no copy of included", () => {
    const { songs, held } = sixSongs();
    const edited = repeatLocal(removeLocal(held, "s0"), "all");

    expect(handBack(edited, false)).toEqual([
      { kind: "repeat", mode: "all" },
      { kind: "play", trackIds: songs.slice(1).map((song) => song.id), index: 0 },
    ]);
  });

  it("turns shuffle first and sends the order before shuffle for an edited queue", () => {
    const shuffled = shuffleLocal(empty, true, inOrder);
    const queue = clearLocal(playLocal(shuffled, [one, two, three], 2, inOrder));

    expect(handBack(queue, false)).toEqual([
      { kind: "shuffle", on: true },
      { kind: "play", trackIds: [three.id], index: 0 },
    ]);

    const played = playLocal(shuffled, [one, two, three], 2, inOrder);

    expect(handBack(played, false)).toEqual([
      { kind: "shuffle", on: true },
      { kind: "play", trackIds: [one.id, two.id, three.id], index: 2 },
    ]);
  });

  it("hands back the whole queue once a new queue left unanswered replaced the server's", () => {
    const { songs, held } = sixSongs();

    expect(handBack(jumpLocal(held, "s4"), true)).toEqual([
      { kind: "play", trackIds: songs.map((song) => song.id), index: 4 },
    ]);
  });
});
