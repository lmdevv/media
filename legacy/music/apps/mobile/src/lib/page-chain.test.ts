import { describe, expect, it } from "vitest";

import {
  FIRST_PAGE,
  extendChain,
  joinChain,
  pageBounds,
  readPages,
  reconcileChain,
  splitChain,
} from "./page-chain";
import type { PageResult } from "./page-chain";

const page = (items: ReadonlyArray<string>, cursor: string, done: boolean): PageResult<string> => ({
  items,
  cursor,
  done,
});

const lookup =
  (pages: Record<string, PageResult<string>>) =>
  (cursor: string | null): PageResult<string> | undefined =>
    pages[cursor ?? "first"];

describe("pageBounds", () => {
  it("ends each page where the next one starts, and the last one nowhere", () => {
    const cursors = [null, "b", "c"];

    expect(pageBounds(cursors, 0)).toEqual({ cursor: null, end: "b" });
    expect(pageBounds(cursors, 2)).toEqual({ cursor: "c", end: null });
  });
});

describe("joinChain", () => {
  it("is loading before the first page arrives", () => {
    expect(joinChain(FIRST_PAGE, lookup({}))).toEqual({ items: [], status: { kind: "loading" } });
  });

  it("offers the next page when the last loaded one says more follow", () => {
    const view = joinChain([null], lookup({ first: page(["a", "b"], "c", false) }));

    expect(view).toEqual({ items: ["a", "b"], status: { kind: "more", next: "c" } });
  });

  it("joins pages in order and ends when the last is done", () => {
    const view = joinChain(
      [null, "c"],
      lookup({ first: page(["a", "b"], "c", false), c: page(["c"], "d", true) }),
    );

    expect(view).toEqual({ items: ["a", "b", "c"], status: { kind: "done" } });
  });

  it("stops at a page still loading, so the list never shows a hole", () => {
    const view = joinChain(
      [null, "c", "e"],
      lookup({ first: page(["a"], "c", false), e: page(["e"], "f", true) }),
    );

    expect(view).toEqual({ items: ["a"], status: { kind: "loading" } });
  });

  it("keeps going past an empty page that says more follow", () => {
    const view = joinChain([null], lookup({ first: page([], "x", false) }));

    expect(view.status).toEqual({ kind: "more", next: "x" });
  });
});

describe("splitChain", () => {
  it("leaves the chain alone when a page ends where the next begins", () => {
    const cursors = [null, "c"];

    expect(splitChain(cursors, null, "c")).toBe(cursors);
  });

  it("puts a page between two when the first outgrew its bounds", () => {
    expect(splitChain([null, "e"], null, "c")).toEqual([null, "c", "e"]);
  });

  it("ignores the last page, whose cursor is the next page to load", () => {
    expect(splitChain([null, "c"], "c", "e")).toEqual([null, "c"]);
  });
});

describe("reconcileChain", () => {
  it("splits every grown page and keeps the chain when nothing grew", () => {
    const cursors = [null, "e"];
    const grown = lookup({ first: page(["a", "b"], "c", false), e: page(["e"], "f", true) });
    const exact = lookup({ first: page(["a", "b"], "e", false) });

    expect(reconcileChain(cursors, grown)).toEqual([null, "c", "e"]);
    expect(reconcileChain(cursors, exact)).toBe(cursors);
  });
});

describe("extendChain", () => {
  it("adds a page once", () => {
    expect(extendChain([null], "c")).toEqual([null, "c"]);
    expect(extendChain([null, "c"], "c")).toEqual([null, "c"]);
  });
});

describe("readPages", () => {
  const pages = {
    first: page(["a", "b"], "c", false),
    c: page(["c", "d"], "e", false),
    e: page(["e"], "f", true),
  };

  const read = (cursor: string | null) =>
    Promise.resolve(lookup(pages)(cursor) ?? page([], "", true));

  it("follows the cursors to the end", async () => {
    await expect(readPages(read, 100)).resolves.toEqual(["a", "b", "c", "d", "e"]);
  });

  it("stops at max", async () => {
    await expect(readPages(read, 3)).resolves.toEqual(["a", "b", "c"]);
  });

  it("refuses a list whose cursor doesn't move", async () => {
    await expect(
      readPages((cursor) => Promise.resolve(page(["a"], cursor ?? "x", false)), 10),
    ).rejects.toThrow("stopped advancing");
  });
});
