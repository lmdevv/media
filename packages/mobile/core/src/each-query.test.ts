import type { QueryState } from "@media/sdk/react";
import { describe, expect, it } from "vitest";

import { eachStore } from "./each-query";
import type { Watch } from "./pages";

/** A watch whose state the test sets, the way a live query publishes. */
const watchOf = (initial: QueryState<string>) => {
  let state = initial;
  const listeners = new Set<() => void>();

  const watch: Watch<string> = {
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => listeners.delete(onChange);
    },
    getSnapshot: () => state,
  };

  const publish = (next: QueryState<string>): void => {
    state = next;

    for (const listener of listeners) listener();
  };

  return { watch, publish, listening: () => listeners.size };
};

describe("eachStore", () => {
  it("gives each query's state in order, the same array until one changes", () => {
    const first = watchOf({ status: "loading" });
    const second = watchOf({ status: "success", data: "b" });
    const store = eachStore([first.watch, second.watch]);
    const before = store.getSnapshot();

    expect(before).toEqual([{ status: "loading" }, { status: "success", data: "b" }]);
    expect(store.getSnapshot()).toBe(before);

    first.publish({ status: "success", data: "a" });

    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toEqual([
      { status: "success", data: "a" },
      { status: "success", data: "b" },
    ]);
  });

  it("tells a subscriber when any query changes, and stops following them all on unsubscribe", () => {
    const first = watchOf({ status: "loading" });
    const second = watchOf({ status: "loading" });
    const store = eachStore([first.watch, second.watch]);
    let changes = 0;

    const stop = store.subscribe(() => {
      changes += 1;
    });

    second.publish({ status: "success", data: "b" });
    expect(changes).toBe(1);

    stop();
    expect([first.listening(), second.listening()]).toEqual([0, 0]);
  });

  it("is an empty list, kept the same, when it follows nothing", () => {
    const store = eachStore<string>([]);

    expect(store.getSnapshot()).toEqual([]);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
});
