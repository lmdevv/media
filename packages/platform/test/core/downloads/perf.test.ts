import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import type { DownloadItem } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { PAGE_ROWS_MAX } from "../../../convex/core/lib/paginate";
import { logMark, usageSince } from "../../admin";
import { enroll, member, sharedAdmin } from "../../devices";
import { allPages, counted, rowsBetween } from "../../pages";
import { movie, seedLibraries, share, shareThroughEveryGroup } from "../../probe";
import { unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const LIBRARIES = 200;

const LISTS = 20;

const FETCHES = 50;

const LIST_PAGE = 200;

type Entry = FunctionReturnType<typeof api.core.downloads.list>["page"][number];

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Number.NaN;

const itemOf = (id: Id<"mediaFiles">): DownloadItem => ({ kind: "file", id });

const timed = async <A>(call: () => Promise<A>): Promise<number> => {
  const started = performance.now();

  await call();

  return performance.now() - started;
};

describe.skipIf(stack === undefined)("downloads at scale", { timeout: 900_000 }, () => {
  it("lists a full page from 200 libraries and issues tickets with bounded reads", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const aiko = await member(stack, "perf-downloads");

    await enroll(aiko.signedIn, "Phone");

    const libraries = await seedLibraries(
      stack,
      admin,
      Array.from({ length: LIBRARIES }, (_, n) => ({
        name: `perf-${n}-${unique()}`,
        kind: "movies" as const,
        items: [movie(`kept-${n}.mkv`, 0), movie(`spare-${n}.mkv`, 0)],
      })),
    );

    const [kept, spare] = [0, 1].map((slot) =>
      libraries.flatMap((library) => library.fileIds.slice(slot, slot + 1)),
    );

    if (kept === undefined || spare === undefined) throw new Error("no items seeded");

    const client = aiko.signedIn.client;

    await inOrder(libraries, async (library) =>
      share(admin, library.libraryId, { kind: "user", userId: aiko.userId }, "view"),
    );
    await inOrder(kept, async (id) =>
      client.mutation(api.core.downloads.add, { item: itemOf(id) }),
    );

    const mark = await logMark(stack);

    // Adding a spare item before each list changes the rows it reads, so no list is served from
    // the query cache.
    const lists = await inOrder(spare.slice(0, LISTS), async (id) => {
      await client.mutation(api.core.downloads.add, { item: itemOf(id) });

      const ms = await timed(async () =>
        client.query(api.core.downloads.list, { paginationOpts: { numItems: 200, cursor: null } }),
      );

      await client.mutation(api.core.downloads.remove, { item: itemOf(id) });

      return ms;
    });

    const fetches = await inOrder(
      Array.from({ length: FETCHES }, (_, n) => kept[n % kept.length]),
      async (id) =>
        id === undefined
          ? Number.NaN
          : timed(async () => client.mutation(api.core.downloads.fetch, { item: itemOf(id) })),
    );

    const listReads = (await usageSince(stack, mark, api.core.downloads.list, LISTS))
      .filter((call) => call.committed)
      .map((call) => call.reads);

    const fetchReads = (await usageSince(stack, mark, api.core.downloads.fetch, FETCHES))
      .filter((call) => call.committed)
      .map((call) => call.reads);

    process.stdout.write(
      `downloads list pages from ${LIBRARIES} libraries over ${LISTS} uncached calls: ` +
        `p50 ${median(lists).toFixed(1)} ms, reads p50 ${median(listReads)} max ${Math.max(...listReads)}\n` +
        `downloads fetch over ${FETCHES} calls: p50 ${median(fetches).toFixed(1)} ms, ` +
        `reads p50 ${median(fetchReads)} max ${Math.max(...fetchReads)}\n`,
    );

    expect(listReads.length).toBeGreaterThanOrEqual(LISTS);
    expect(fetchReads.length).toBeGreaterThanOrEqual(FETCHES);
    expect(Math.max(...listReads)).toBeLessThanOrEqual(1000);
    expect(Math.max(...fetchReads)).toBeLessThanOrEqual(20);
  });

  it("lists within one call's budget for a person in the most groups, over distinct libraries", async () => {
    if (stack === undefined) return;

    const admin = await sharedAdmin(stack);
    const viewer = await member(stack, "downloads-groups");

    await enroll(viewer.signedIn, "Phone");

    const libraries = await seedLibraries(
      stack,
      admin,
      Array.from({ length: LIBRARIES }, (_, n) => ({
        name: `groups-${n}-${unique()}`,
        kind: "movies" as const,
        items: [movie(`kept-${n}.mkv`, 0), movie(`ahead-${n}.mkv`, 0)],
      })),
    );

    await shareThroughEveryGroup(
      admin,
      admin,
      viewer,
      libraries.map((library) => library.libraryId),
    );

    const [kept, ahead] = [0, 1].map((slot) =>
      libraries.flatMap((library) => library.fileIds.slice(slot, slot + 1).map(itemOf)),
    );

    if (kept === undefined || ahead === undefined) throw new Error("no items seeded");

    const client = viewer.signedIn.client;
    const add = (item: DownloadItem) => client.mutation(api.core.downloads.add, { item });

    await inOrder(kept, add);

    const list = counted<Entry>(async (paginationOpts) =>
      client.query(api.core.downloads.list, { paginationOpts }),
    );

    const mark = await logMark(stack);
    const pages = await allPages(list.load, LIST_PAGE);
    const listed = pages.flatMap((found) => found.page);
    const [first] = pages;

    if (first === undefined) throw new Error("listed no page");

    expect(listed.map((entry) => entry.item)).toEqual(kept.toReversed());
    expect(listed.every((entry) => entry.state === "available")).toBe(true);

    const newer = ahead.slice(0, first.page.length + 1);

    await inOrder(newer, add);

    const reloaded = await rowsBetween(list.load, LIST_PAGE, null, first.continueCursor);

    expect(reloaded.map((entry) => entry.item)).toEqual([
      ...newer.toReversed(),
      ...first.page.map((entry) => entry.item),
    ]);

    const reads = (await usageSince(stack, mark, api.core.downloads.list, list.calls()))
      .filter((call) => call.committed)
      .map((call) => call.reads);

    process.stdout.write(
      `downloads list from ${LIBRARIES} libraries for a person in the most groups: ` +
        `${first.page.length} rows a page, reads per call ${reads.join(", ")}\n`,
    );

    expect(Math.max(...reads)).toBeLessThanOrEqual(PAGE_ROWS_MAX);
  });
});
