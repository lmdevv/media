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

const split = (rows: ReadonlyArray<string>, splitCursor: string, endCursor: string) => ({
  status: "success" as const,
  data: {
    page: rows,
    isDone: false,
    continueCursor: endCursor,
    splitCursor,
    pageStatus: "SplitRequired" as const,
  } satisfies Page,
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

  it("splits a pinned page the server says to split, and shows its rows only from the halves", () => {
    const first = watchOf(page(["a"], false, "after-a"));
    const pinned = watchOf(split(["a"], "after-a1", "after-a"));
    const lower = watchOf(page(["a", "a1"], false, "after-a1"));
    const upper = watchOf({ status: "loading" });
    const second = watchOf(page(["b"], true));
    const asked: Array<PageSpan> = [];

    const store = pagedStore((span) => {
      asked.push(span);

      if (span.cursor === "after-a") return second.watch;

      if (span.cursor === "after-a1") return upper.watch;

      if (span.endCursor === "after-a1") return lower.watch;

      return span.endCursor === undefined ? first.watch : pinned.watch;
    });

    const stop = store.subscribe(() => undefined);
    const list = store.getSnapshot();

    if (list.status === "ready" && list.next.kind === "more") list.next.load();

    expect(asked).toContainEqual({ cursor: null, endCursor: "after-a1" });
    expect(asked).toContainEqual({ cursor: "after-a1", endCursor: "after-a" });
    expect(pinned.listening()).toBe(0);
    expect(store.getSnapshot()).toMatchObject({ rows: ["a", "a1"], next: { kind: "loading" } });

    upper.publish(page(["a2"], false, "after-a"));

    expect(store.getSnapshot()).toMatchObject({
      rows: ["a", "a1", "a2", "b"],
      next: { kind: "done" },
    });

    stop();

    expect(lower.listening() + upper.listening() + second.listening()).toBe(0);
  });

  it("follows the next page by itself when the last page arrives empty but not done", () => {
    const first = watchOf(page([], false, "after-hidden"));
    const second = watchOf(page(["b"], true));
    const asked: Array<PageSpan> = [];

    const store = pagedStore((span) => {
      asked.push(span);

      if (span.cursor === "after-hidden") return second.watch;

      return span.endCursor === undefined
        ? first.watch
        : watchOf(page([], false, "after-hidden")).watch;
    });

    const stop = store.subscribe(() => undefined);

    expect(store.getSnapshot()).toMatchObject({ rows: ["b"], next: { kind: "done" } });
    expect(asked).toContainEqual({ cursor: "after-hidden" });

    stop();
  });

  it("loads the rest from the split as the next page when the last page must split", () => {
    const first = watchOf(split(["a"], "after-a", "after-b"));
    const lower = watchOf(page(["a"], false, "after-a"));
    const rest = watchOf(page(["b"], true));
    const asked: Array<PageSpan> = [];

    const store = pagedStore((span) => {
      asked.push(span);

      if (span.cursor === "after-a") return rest.watch;

      return span.endCursor === "after-a" ? lower.watch : first.watch;
    });

    const stop = store.subscribe(() => undefined);

    expect(asked).toEqual([
      { cursor: null },
      { cursor: null, endCursor: "after-a" },
      { cursor: "after-a" },
    ]);
    expect(first.listening()).toBe(0);
    expect(store.getSnapshot()).toMatchObject({ rows: ["a", "b"], next: { kind: "done" } });

    stop();

    expect(lower.listening() + rest.listening()).toBe(0);
  });
});
