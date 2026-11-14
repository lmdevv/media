import { describe, expect, it } from "vitest";

import { trackOf } from "@/lib/test-fixtures";

import {
  addLocal,
  clearLocal,
  handBack,
  jumpLocal,
  moveLocal,
  playLocal,
  recordPlay,
  removeLocal,
  repeatLocal,
  seedLocal,
  shuffleLocal,
} from "./local-queue";

const one = trackOf("Safe from Harm");

const two = trackOf("One Love");

const three = trackOf("Blue Lines");

const empty = seedLocal<typeof one>(null, () => null);

const titles = (queue: ReturnType<typeof playLocal<typeof one>>) =>
  queue.state.entries.map((entry) => entry.track.title);

describe("seedLocal", () => {
  it("keeps the server's entries this phone holds, and its entry playing when it holds that one", () => {
    const server = {
      entries: [
        { itemId: "a", autoplay: false, track: one },
        { itemId: "b", autoplay: false, track: two },
        { itemId: "c", autoplay: true, track: three },
      ],
      current: "c",
      shuffle: true,
      repeat: "all" as const,
      autoplay: true,
    };

    const held = seedLocal(server, (id) =>
      id === one.id || id === three.id ? { ...one, id } : null,
    );

    expect(held.state.entries.map((entry) => entry.itemId)).toEqual(["a", "c"]);
    expect(held.state.current).toBe("c");
    expect(held.state).toMatchObject({ shuffle: true, repeat: "all" });
    expect(held.changed).toBe(false);

    const without = seedLocal(server, (id) => (id === one.id ? one : null));

    expect(without.state.current).toBe("a");
  });
});

describe("the phone's own queue", () => {
  it("plays songs from the one picked, with ids it has not used", () => {
    const queue = playLocal(empty, [one, two, three], 1);

    expect(titles(queue)).toEqual(["Safe from Harm", "One Love", "Blue Lines"]);
    expect(queue.state.current).toBe("local-2");
    expect(playLocal(queue, [one]).state.current).toBe("local-4");
    expect(queue.changed).toBe(true);
  });

  it("jumps, adds next or last, removes, moves, and clears after the song playing", () => {
    const queue = playLocal(empty, [one, two]);

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

  it("shuffles what comes after the song playing, and puts it back in order", () => {
    const queue = playLocal(empty, [one, two, three]);
    const shuffled = shuffleLocal(queue, true, () => 0);

    expect(shuffled.state.shuffle).toBe(true);
    expect(shuffled.state.entries[0]?.itemId).toBe("local-1");
    expect(titles(shuffleLocal(shuffled, false, () => 0))).toEqual(titles(queue));
    expect(repeatLocal(queue, "one").state.repeat).toBe("one");
  });

  it("hands back its plays always, and its queue only once a command ran here", () => {
    const seeded = recordPlay(empty, one.id, 42);

    expect(handBack(seeded)).toEqual({ queue: null, plays: [{ trackId: one.id, playedAt: 42 }] });

    const played = jumpLocal(playLocal(seeded, [one, two]), "local-2");

    expect(handBack(played).queue).toEqual({ trackIds: [one.id, two.id], index: 1 });
  });
});
