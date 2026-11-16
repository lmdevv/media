import { describe, expect, it } from "vitest";

import { TrackShelf } from "./track-shelf";
import type { TrackWatch } from "./track-shelf";

type State = ReturnType<TrackWatch<string>["getSnapshot"]>;

/** A followed query a test answers, which records whether anyone follows it. */
class TestWatch implements TrackWatch<string> {
  state: State = { status: "loading" };
  followers = 0;
  readonly #listeners = new Set<() => void>();

  subscribe = (onChange: () => void): (() => void) => {
    this.followers += 1;
    this.#listeners.add(onChange);

    return () => {
      this.followers -= 1;
      this.#listeners.delete(onChange);
    };
  };

  getSnapshot = (): State => this.state;

  answer(state: State): void {
    this.state = state;

    for (const listener of this.#listeners) listener();
  }
}

const shelfOf = () => {
  const watches = new Map<string, TestWatch>();

  const shelf = new TrackShelf<string>((trackId) => {
    const watch = new TestWatch();

    watches.set(trackId, watch);

    return watch;
  });

  const watchOf = (trackId: string): TestWatch => {
    const watch = watches.get(trackId);

    if (watch === undefined) throw new Error(`nobody follows ${trackId}`);

    return watch;
  };

  return { shelf, watchOf };
};

describe("TrackShelf", () => {
  it("shows each song once its details answer, and a failed one as null", () => {
    const { shelf, watchOf } = shelfOf();
    let changes = 0;

    shelf.subscribe(() => {
      changes += 1;
    });
    shelf.want(["a", "b"]);

    expect(shelf.getSnapshot().size).toBe(0);

    watchOf("a").answer({ status: "success", data: "Song A" });
    watchOf("b").answer({ status: "error" });

    expect(shelf.getSnapshot()).toEqual(
      new Map([
        ["a", "Song A"],
        ["b", null],
      ]),
    );
    expect(changes).toBe(2);
  });

  it("stops following songs no longer asked for, and keeps one snapshot while nothing changes", () => {
    const { shelf, watchOf } = shelfOf();

    shelf.want(["a", "b"]);
    watchOf("a").answer({ status: "success", data: "Song A" });

    const before = shelf.getSnapshot();

    shelf.want(["a", "b"]);

    expect(shelf.getSnapshot()).toBe(before);

    shelf.want(["a"]);

    expect(watchOf("b").followers).toBe(0);

    shelf.clear();

    expect(watchOf("a").followers).toBe(0);
    expect(shelf.getSnapshot().size).toBe(0);
  });
});
