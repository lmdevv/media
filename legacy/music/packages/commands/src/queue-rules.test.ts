import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MAX_QUEUE,
  addedOrder,
  nextIndex,
  playOrder,
  previousIndex,
  shuffledOff,
  shuffledOn,
} from "./queue-rules";
import type { QueueSlot } from "./queue-rules";

const entries = (prefix: string, maxLength = 30): fc.Arbitrary<ReadonlyArray<QueueSlot>> =>
  fc
    .array(fc.boolean(), { maxLength })
    .map((flags) => flags.map((autoplay, position) => ({ id: `${prefix}${position}`, autoplay })));

const queue = entries("q").chain((items) =>
  items.length === 0
    ? fc.constant({ items: [{ id: "q0", autoplay: false }], index: 0 })
    : fc.nat({ max: items.length - 1 }).map((index) => ({ items, index })),
);

/** A source of numbers in `[0, 1)` that replays generated draws, so a shuffle shrinks. */
const random = fc
  .array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), { minLength: 1 })
  .map((draws) => {
    let next = 0;

    return (): number => {
      next += 1;

      return draws[next % draws.length] ?? 0;
    };
  });

const ids = (items: ReadonlyArray<QueueSlot>): ReadonlyArray<string> => items.map(({ id }) => id);

describe("next and previous", () => {
  it("steps forward, wraps only under repeat all, and runs out at the end otherwise", () => {
    expect(nextIndex(0, 3, "off")).toBe(1);
    expect(nextIndex(2, 3, "off")).toBeNull();
    expect(nextIndex(2, 3, "one")).toBeNull();
    expect(nextIndex(2, 3, "all")).toBe(0);
    expect(nextIndex(0, 0, "all")).toBeNull();
  });

  it("restarts after three seconds, else goes back, wrapping only under repeat all", () => {
    expect(previousIndex(3001, 2, 3, "off")).toBe(2);
    expect(previousIndex(3000, 2, 3, "off")).toBe(1);
    expect(previousIndex(0, 0, 3, "off")).toBe(0);
    expect(previousIndex(0, 0, 3, "all")).toBe(2);
  });
});

describe("shuffle", () => {
  it("plays the current entry first, people's songs before autoplay's, and turns back", () => {
    fc.assert(
      fc.property(queue, random, ({ items, index }, draw) => {
        const current = items[index];
        const on = shuffledOn({ items, index, unshuffled: undefined }, draw);
        const rest = on.items.slice(1);
        const firstAutoplay = rest.findIndex((item) => item.autoplay);

        expect(on.items[on.index]).toBe(current);
        expect(on.index).toBe(0);
        expect(ids(on.items).toSorted()).toEqual(ids(items).toSorted());

        expect(
          firstAutoplay === -1 || rest.slice(firstAutoplay).every((item) => item.autoplay),
        ).toBe(true);

        const off = shuffledOff(on);

        expect(ids(off.items)).toEqual(ids(items));
        expect(off.items[off.index]).toBe(current);
        expect(off.unshuffled).toBeUndefined();
      }),
    );
  });

  it("starts a shuffled list on the chosen song and keeps at most the queue's limit", () => {
    const long = Array.from({ length: MAX_QUEUE + 5 }, (_, position) => ({
      id: `s${position}`,
      autoplay: false,
    }));

    fc.assert(
      fc.property(fc.nat({ max: long.length - 1 }), random, (index, draw) => {
        const order = playOrder(long, index, true, draw);

        expect(order.items[0]).toBe(long[index]);
        expect(order.items).toHaveLength(MAX_QUEUE);
        expect(new Set(order.unshuffled)).toEqual(new Set(ids(order.items)));
      }),
    );
  });
});

describe("adding to the queue", () => {
  it("keeps the current entry and puts songs next, or after people's songs but before autoplay's", () => {
    fc.assert(
      fc.property(
        queue,
        entries("a", 5),
        fc.constantFrom("next" as const, "end" as const),
        ({ items, index }, added, placement) => {
          const order = addedOrder({ items, index, unshuffled: undefined }, added, placement);
          const at = order.items.findIndex((item) => item.id === added[0]?.id);
          const upcoming = order.items.slice(order.index + 1);

          expect(order.items[order.index]).toBe(items[index]);
          expect(ids(order.items.slice(at, at + added.length))).toEqual(
            added.length === 0 ? [] : ids(added),
          );

          if (placement === "next" && added.length > 0) expect(at).toBe(index + 1);

          if (placement === "end" && added.length > 0) {
            expect(
              upcoming
                .slice(
                  0,
                  upcoming.findIndex((item) => item.id === added[0]?.id),
                )
                .some((item) => item.autoplay && !added.includes(item)),
            ).toBe(false);
          }
        },
      ),
    );
  });

  it("adds the songs to the order before shuffle at the same place", () => {
    const one = { id: "1", autoplay: false };
    const two = { id: "2", autoplay: false };
    const three = { id: "3", autoplay: true };

    const order = addedOrder(
      { items: [two, one, three], index: 0, unshuffled: ["1", "2", "3"] },
      [{ id: "4", autoplay: false }],
      "next",
    );

    expect(ids(order.items)).toEqual(["2", "4", "1", "3"]);
    expect(order.unshuffled).toEqual(["1", "2", "4", "3"]);
  });
});
