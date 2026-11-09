import type { QueryState } from "@media/sdk/react";
import { describe, expect, it } from "vitest";

import { combinePages, pagedStore } from "./pages";
import type { PageSpan } from "./pages";
import type { PageOf, Watch } from "./pages";

type Page = PageOf<string>;

const page = (rows: ReadonlyArray<string>, isDone: boolean, continueCursor = "next") => ({
  status: "success" as const,
  data: { page: rows, isDone, continueCursor } satisfies Page,
});

/** A watch whose state the test sets, the way a live query publishes. */
const watchOf = (initial: QueryState<Page>) => {
  let state = initial;
  const listeners = new Set<() => void>();

  const watch: Watch<Page> = {
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => listeners.delete(onChange);
    },
    getSnapshot: () => state,
  };

  const publish = (next: QueryState<Page>): void => {
    state = next;

    for (const listener of listeners) listener();
  };

  return { watch, publish, listening: () => listeners.size };
};

describe("combinePages", () => {
  it("is loading until the first page arrives", () => {
    expect(combinePages<string, Error>([{ status: "loading" }], () => undefined)).toEqual({
      status: "loading",
    });
  });

  it("joins every page's rows in order and offers the cursor the last page ended at", () => {
    const asked: Array<string> = [];

    const list = combinePages(
      [page(["a", "b"], false, "c1"), page(["c"], false, "c2")],
      (cursor) => {
        asked.push(cursor);
      },
    );

    expect(list.status === "ready" ? list.rows : null).toEqual(["a", "b", "c"]);

    if (list.status === "ready" && list.next.kind === "more") list.next.load();

    expect(asked).toEqual(["c2"]);
  });

  it("is done when the last page is", () => {
    expect(combinePages([page(["a"], true)], () => undefined)).toMatchObject({
      status: "ready",
      rows: ["a"],
      next: { kind: "done" },
    });
  });

  it("keeps the rows above a page that is still loading or failed", () => {
    expect(
      combinePages<string, Error>([page(["a"], false), { status: "loading" }], () => undefined),
    ).toMatchObject({
      status: "ready",
      rows: ["a"],
      next: { kind: "loading" },
    });

    const failed = combinePages<string, Error>(
      [page(["a"], false), { status: "error", error: new Error("Gone"), retry: () => undefined }],
      () => undefined,
    );

    expect(failed).toMatchObject({
      status: "ready",
      rows: ["a"],
      next: { kind: "failed", message: "Gone" },
    });
  });

  it("fails the list when the first page fails", () => {
    const list = combinePages<string, Error>(
      [{ status: "error", error: new Error("Forbidden"), retry: () => undefined }],
      () => undefined,
    );

    expect(list).toMatchObject({ status: "failed", message: "Forbidden" });
  });
});

describe("pagedStore", () => {
  it("returns the same snapshot until a page changes, then the new rows", () => {
    const first = watchOf(page(["a"], true));
    const store = pagedStore(() => first.watch);
    const before = store.getSnapshot();

    expect(store.getSnapshot()).toBe(before);

    first.publish(page(["a", "b"], true));

    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toMatchObject({ rows: ["a", "b"] });
  });

  it("loads the next page from the first page's end and pins the first page to end there", () => {
    const first = watchOf(page(["a"], false, "after-a"));
    const pinned = watchOf({ status: "loading" });
    const second = watchOf({ status: "loading" });
    const asked: Array<PageSpan> = [];

    const store = pagedStore((span) => {
      asked.push(span);

      if (span.cursor === null) return span.endCursor === undefined ? first.watch : pinned.watch;

      return second.watch;
    });

    let changes = 0;

    const stop = store.subscribe(() => {
      changes += 1;
    });

    const list = store.getSnapshot();

    if (list.status === "ready" && list.next.kind === "more") {
      list.next.load();
      list.next.load();
    }

    expect(asked).toEqual([
      { cursor: null },
      { cursor: null, endCursor: "after-a" },
      { cursor: "after-a" },
    ]);
    expect(pinned.listening()).toBe(1);
    expect(second.listening()).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ rows: ["a"], next: { kind: "loading" } });

    second.publish(page(["b"], true));
    pinned.publish(page(["a", "a2"], false, "after-a"));

    expect(changes).toBe(3);
    expect(store.getSnapshot()).toMatchObject({ rows: ["a", "a2", "b"], next: { kind: "done" } });

    stop();

    expect(first.listening() + pinned.listening() + second.listening()).toBe(0);
  });

  it("stops following the open-ended page once the page pinned in its place answers", () => {
    const first = watchOf(page(["a"], false, "after-a"));
    const pinned = watchOf({ status: "loading" });
    const second = watchOf(page(["b"], true));

    const store = pagedStore((span) => {
      if (span.cursor !== null) return second.watch;

      return span.endCursor === undefined ? first.watch : pinned.watch;
    });

    const stop = store.subscribe(() => undefined);
    const list = store.getSnapshot();

    if (list.status === "ready" && list.next.kind === "more") list.next.load();

    expect(first.listening()).toBe(1);

    pinned.publish(page(["a"], false, "after-a"));

    expect(first.listening()).toBe(0);
    expect(store.getSnapshot()).toMatchObject({ rows: ["a", "b"], next: { kind: "done" } });

    stop();

    expect(pinned.listening() + second.listening()).toBe(0);
  });

  it("stops following the open-ended page at once when the pinned page is ready as it starts", () => {
    const first = watchOf(page(["a"], false, "after-a"));
    const pinned = watchOf(page(["a"], false, "after-a"));
    const second = watchOf(page(["b"], true));

    const store = pagedStore((span) => {
      if (span.cursor !== null) return second.watch;

      return span.endCursor === undefined ? first.watch : pinned.watch;
    });

    const stop = store.subscribe(() => undefined);
    const list = store.getSnapshot();

    expect(first.listening()).toBe(1);

    if (list.status === "ready" && list.next.kind === "more") list.next.load();

    expect(first.listening()).toBe(0);
    expect(pinned.listening()).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ rows: ["a", "b"], next: { kind: "done" } });

    const late = store.subscribe(() => undefined);

    expect(first.listening()).toBe(0);

    late();
    stop();

    expect(pinned.listening() + second.listening()).toBe(0);
  });
});
