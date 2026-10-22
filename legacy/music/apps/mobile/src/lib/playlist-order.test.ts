import {
  array,
  assert,
  constant,
  integer,
  nat,
  property,
  shuffledSubarray,
  tuple,
  uniqueArray,
} from "fast-check";
import { describe, expect, it } from "vitest";

import { applyMove, moveIndex, planMoves, reconcileOrder } from "./playlist-order";

/** Distinct entries and a shuffled copy of them. */
const reordering = uniqueArray(integer({ min: 0, max: 500 }), { maxLength: 40 }).chain((list) =>
  tuple(constant(list), shuffledSubarray(list, { minLength: list.length })),
);

/** Length of the longest increasing subsequence, the slow and obvious way. */
const longestRun = (values: ReadonlyArray<number>): number => {
  const best = values.map(() => 1);

  values.forEach((value, index) => {
    for (let before = 0; before < index; before += 1) {
      if ((values[before] ?? 0) < value)
        best[index] = Math.max(best[index] ?? 1, (best[before] ?? 1) + 1);
    }
  });

  return Math.max(0, ...best);
};

describe("moveIndex", () => {
  it("moves one entry down and up", () => {
    expect(moveIndex(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveIndex(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveIndex(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("applyMove", () => {
  it("puts the entry right after another, or first", () => {
    expect(applyMove(["a", "b", "c"], { itemId: "a", afterItemId: "c" })).toEqual(["b", "c", "a"]);
    expect(applyMove(["a", "b", "c"], { itemId: "c", afterItemId: null })).toEqual(["c", "a", "b"]);
  });

  it("leaves the list alone when either entry is gone", () => {
    expect(applyMove(["a", "b"], { itemId: "z", afterItemId: null })).toEqual(["a", "b"]);
    expect(applyMove(["a", "b"], { itemId: "a", afterItemId: "z" })).toEqual(["a", "b"]);
  });
});

describe("planMoves", () => {
  it("saves one drag as one move", () => {
    expect(planMoves(["a", "b", "c", "d"], ["b", "c", "d", "a"])).toEqual([
      { itemId: "a", afterItemId: "d" },
    ]);
    expect(planMoves(["a", "b", "c", "d"], ["d", "a", "b", "c"])).toEqual([
      { itemId: "d", afterItemId: null },
    ]);
  });

  it("plans nothing for an unchanged order", () => {
    expect(planMoves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });

  it("reaches the target through the server's moves", () => {
    assert(
      property(reordering, ([current, target]) => {
        const result = planMoves(current, target).reduce<ReadonlyArray<number>>(applyMove, current);

        expect(result).toEqual(target);
      }),
    );
  });

  it("moves only the entries outside the longest run already in order", () => {
    assert(
      property(reordering, ([current, target]) => {
        const positions = target.map((id) => current.indexOf(id));

        expect(planMoves(current, target)).toHaveLength(target.length - longestRun(positions));
      }),
    );
  });

  it("keeps a sequence of drags to as many moves as there were drags, or fewer", () => {
    assert(
      property(
        uniqueArray(integer(), { minLength: 1, maxLength: 30 }),
        array(tuple(nat(), nat()), { maxLength: 5 }),
        (current, drags) => {
          const target = drags.reduce<ReadonlyArray<number>>(
            (list, [from, to]) => moveIndex(list, from % list.length, to % list.length),
            current,
          );

          expect(planMoves(current, target).length).toBeLessThanOrEqual(drags.length);
        },
      ),
    );
  });
});

describe("reconcileOrder", () => {
  it("drops entries removed meanwhile and appends ones added meanwhile", () => {
    expect(reconcileOrder(["c", "a", "b"], ["a", "b", "d", "e"])).toEqual(["a", "b", "d", "e"]);
    expect(reconcileOrder(["c", "a", "b"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
  });
});
