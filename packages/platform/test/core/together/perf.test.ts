import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import type { DomainItem } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { PAGE_ROWS_MAX } from "../../../convex/core/lib/paginate";
import { logMark, usageSince } from "../../admin";
import { member, sharedAdmin } from "../../devices";
import { allPages, counted, rowsBetween } from "../../pages";
import { movie, seedLibraries, shareThroughEveryGroup } from "../../probe";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const LIBRARIES = 240;

type Entry = FunctionReturnType<typeof api.core.together.queue>["page"][number];

describe.skipIf(stack === undefined)("a group session's queue", { timeout: 600_000 }, () => {
  it("reads within one call's budget for a viewer in the most groups, over distinct libraries", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const host = await member(stack, "host");
    const viewer = await member(stack, "viewer");

    const libraries = await seedLibraries(
      stack,
      host,
      Array.from({ length: LIBRARIES }, (_, n) => ({
        name: `queue-${n}`,
        kind: "movies",
        items: [movie(`movie-${n}`, 0)],
      })),
    );

    await shareThroughEveryGroup(
      admin,
      host,
      viewer,
      libraries.map((library) => library.libraryId),
    );

    const items = libraries.map(({ itemIds: [itemId] }): DomainItem => {
      if (itemId === undefined) throw new Error("seeded a library with no item");

      return { domain: "movies", ref: { type: "title", id: itemId } };
    });

    const [first] = items;

    if (first === undefined) throw new Error("seeded no item");

    const add = (item: DomainItem, at: "next" | "end") =>
      host.signedIn.client.mutation(api.core.together.add, { item, at });

    const { link } = await host.signedIn.client.action(api.core.together.create, { item: first });

    await viewer.signedIn.client.mutation(api.core.together.join, { domain: "movies", link });

    const queued = await inOrder(items, async (item) => (await add(item, "end")).entryId);

    const queue = counted<Entry>(async (paginationOpts) =>
      viewer.signedIn.client.query(api.core.together.queue, { domain: "movies", paginationOpts }),
    );

    const mark = await logMark(stack);
    const pages = await allPages(queue.load, PAGE_ROWS_MAX);
    const listed = pages.flatMap((found) => found.page);
    const [firstPage] = pages;

    if (firstPage === undefined) throw new Error("listed no page");

    expect(listed.map((entry) => entry.entryId)).toEqual(queued);
    expect(listed.map((entry) => entry.item)).toEqual(items);
    expect(firstPage.page.length).toBeGreaterThan(0);

    const ahead = await inOrder(
      Array.from({ length: firstPage.page.length + 1 }, (_, n) => n),
      async (n) => (await add(items[n] ?? first, "next")).entryId,
    );

    const reloaded = await rowsBetween(queue.load, PAGE_ROWS_MAX, null, firstPage.continueCursor);

    expect(reloaded.map((entry) => entry.entryId)).toEqual([
      ...ahead.toReversed(),
      ...firstPage.page.map((entry) => entry.entryId),
    ]);
    expect(reloaded.every((entry) => entry.item !== null)).toBe(true);

    const reads = (await usageSince(stack, mark, api.core.together.queue, queue.calls()))
      .filter((call) => call.committed)
      .map((call) => call.reads);

    process.stdout.write(
      `queue of ${LIBRARIES} libraries for a viewer in the most groups: ` +
        `${firstPage.page.length} entries a page, reads per call ${reads.join(", ")}\n`,
    );

    expect(Math.max(...reads)).toBeLessThanOrEqual(PAGE_ROWS_MAX);
  });
});
