import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { GuestQueue } from "./guest-queue";
import { entry } from "./testing/controller-harness";

describe("guest queue", () => {
  it("plays the whole shared album in order, without autoplay or shuffled entries", async () => {
    const tracks = [entry("first", "first").track, entry("second", "second").track];
    const queue = new GuestQueue(tracks, () => {});
    expect(queue.state().entries.map((row) => row.track.id)).toEqual(["first", "second"]);
    await queue.jump("second");
    expect(queue.state()).toMatchObject({
      current: "second",
      autoplay: false,
      shuffle: false,
      repeat: "off",
      complete: true,
    });
    await queue.play(["first", "second"], 0, false);
    expect(queue.state().current).toBe("first");
  });
  it("a song link refuses another song and preserves its queue", async () => {
    const queue = new GuestQueue([entry("only", "only").track], () => {});
    await expect(queue.jump("another")).rejects.toThrow("This song isn't available");
    await expect(queue.track("another")).rejects.toThrow("This song isn't available");
    await expect(queue.play(["only", "another"], 1, false)).rejects.toThrow();
    expect(queue.state().entries.map((row) => row.track.id)).toEqual(["only"]);
    expect(queue.state().current).toBe("only");
  });
  it("never replaces an album with a subset, reordered queue, or a shuffled queue", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 20 }),
        async (ids) => {
          const queue = new GuestQueue(
            ids.map((id) => entry(id, id).track),
            () => {},
          );

          await expect(queue.play(ids.slice(1), 0, false)).rejects.toThrow();
          await expect(queue.play(ids.toReversed(), 0, false)).rejects.toThrow();
          await expect(queue.play(ids, 0, true)).rejects.toThrow();
          expect(queue.state().entries.map((row) => row.track.id)).toEqual(ids);
        },
      ),
    );
  });
});
