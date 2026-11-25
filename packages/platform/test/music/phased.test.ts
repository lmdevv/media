import type { PaginationOptions, PaginationResult } from "convex/server";
import { describe, expect, it } from "vitest";

import { phasedPage } from "../../convex/music/phased";
import type { PartPage } from "../../convex/music/phased";

/**
 * One part over `rows` as Convex pages an index: a cursor is the index of the next row, a pinned
 * page reads to its `endCursor`, and a page asked to split answers where.
 */
const part =
  (rows: ReadonlyArray<string>, split = false): PartPage<string> =>
  async (options: PaginationOptions): Promise<PaginationResult<string>> => {
    const from = options.cursor === null ? 0 : Number(options.cursor);
    const end = options.endCursor;

    const to =
      end === null || end === undefined
        ? Math.min(rows.length, from + options.numItems)
        : Number(end);

    const page: PaginationResult<string> = {
      page: rows.slice(from, to),
      continueCursor: String(to),
      isDone: to >= rows.length,
    };

    if (split) page.splitCursor = String(from + 1);

    return Promise.resolve(page);
  };

const all = async (
  links: PartPage<string>,
  before: PartPage<string>,
  cursor: string | null = null,
  pages: ReadonlyArray<PaginationResult<string>> = [],
): Promise<ReadonlyArray<PaginationResult<string>>> => {
  const page = await phasedPage({ numItems: 2, cursor }, links, before);
  const next = [...pages, page];

  return page.isDone ? next : all(links, before, page.continueCursor, next);
};

describe("two-part artist pages", () => {
  it("read every linked row, then every row before links, once each and in order", async () => {
    const pages = await all(part(["a", "b", "c"]), part(["x", "y"]));

    expect(pages.flatMap((page) => page.page)).toEqual(["a", "b", "c", "x", "y"]);
    expect(pages.map((page) => page.continueCursor)).toEqual([
      "links:2",
      "linksDone:3",
      "before:2",
    ]);
    expect(pages.at(-1)?.isDone).toBe(true);
  });

  it("read the same rows again for a page pinned to its end, in either part", async () => {
    const links = part(["a", "b", "c"]);
    const before = part(["x", "y"]);

    const pinned = await phasedPage(
      { numItems: 1, cursor: "links:2", endCursor: "linksDone:3" },
      links,
      before,
    );

    expect(pinned).toMatchObject({ page: ["c"], continueCursor: "linksDone:3", isDone: false });

    const second = await phasedPage(
      { numItems: 1, cursor: "linksDone:3", endCursor: "before:2" },
      links,
      before,
    );

    expect(second).toMatchObject({ page: ["x", "y"], continueCursor: "before:2", isDone: true });
  });

  it("name the part of a split, and start over from a cursor of no part", async () => {
    const split = await phasedPage(
      { numItems: 2, cursor: "links:1" },
      part(["a", "b", "c", "d"], true),
      part([]),
    );

    expect(split.splitCursor).toBe("links:2");

    const fresh = await phasedPage({ numItems: 2, cursor: "stale" }, part(["a"]), part(["x"]));

    expect(fresh).toMatchObject({ page: ["a"], continueCursor: "linksDone:1", isDone: false });
  });
});
