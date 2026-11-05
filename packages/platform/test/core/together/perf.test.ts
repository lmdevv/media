import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import type { DomainItem, GrantPrincipal } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { PAGE_ROWS_MAX } from "../../../convex/core/lib/paginate";
import { GROUPS_PER_USER_MAX } from "../../../convex/core/permissions/grants";
import { logMark, usageSince } from "../../admin";
import { member, sharedAdmin } from "../../devices";
import type { Member } from "../../devices";
import { movie, seedLibraries, share } from "../../probe";
import { unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const LIBRARIES = 240;

const SHARING = 24;

type Options = FunctionArgs<typeof api.core.together.queue>["paginationOpts"];

type Page = FunctionReturnType<typeof api.core.together.queue>;

type Entry = Page["page"][number];

const chunks = <T>(values: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, n) =>
    values.slice(n * size, (n + 1) * size),
  );

const queueOf = (who: Member) => {
  let calls = 0;

  const page = (paginationOpts: Options) => {
    calls += 1;

    return who.signedIn.client.query(api.core.together.queue, {
      domain: "movies",
      paginationOpts,
    });
  };

  const all = async (cursor: string | null = null): Promise<ReadonlyArray<Page>> => {
    const found = await page({ numItems: PAGE_ROWS_MAX, cursor });

    return found.isDone ? [found] : [found, ...(await all(found.continueCursor))];
  };

  const between = async (
    cursor: string | null,
    endCursor: string,
  ): Promise<ReadonlyArray<Entry>> => {
    const found = await page({ numItems: PAGE_ROWS_MAX, cursor, endCursor });

    if (found.pageStatus !== "SplitRequired") return found.page;

    const split = found.splitCursor ?? null;

    if (split === null) throw new Error("Convex asked for a split and gave no split cursor");

    return [...(await between(cursor, split)), ...(await between(split, found.continueCursor))];
  };

  return { all, between, calls: () => calls };
};

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

    const groups = await inOrder(
      Array.from({ length: GROUPS_PER_USER_MAX }, (_, n) => n),
      async (n) => {
        const { groupId } = await admin.signedIn.client.mutation(
          api.core.permissions.groups.create,
          { name: `queue-${unique()}-${n}` },
        );

        await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
          groupId,
          userId: viewer.userId,
        });

        return groupId;
      },
    );

    const grantees: ReadonlyArray<GrantPrincipal> = [
      { kind: "user", userId: viewer.userId },
      ...groups.map((groupId): GrantPrincipal => ({ kind: "group", groupId })),
    ];

    await inOrder(chunks(libraries, SHARING), async (batch) =>
      Promise.all(
        batch.map(async ({ libraryId }) =>
          inOrder(grantees, async (grantee) => share(host, libraryId, grantee, "view")),
        ),
      ),
    );

    const items = libraries.map(({ itemIds: [itemId] }): DomainItem => {
      if (itemId === undefined) throw new Error("seeded a library with no item");

      return { domain: "movies", ref: { type: "probeMovie", id: itemId } };
    });

    const [first] = items;

    if (first === undefined) throw new Error("seeded no item");

    const add = (item: DomainItem, at: "next" | "end") =>
      host.signedIn.client.mutation(api.core.together.add, { item, at });

    const { link } = await host.signedIn.client.action(api.core.together.create, { item: first });

    await viewer.signedIn.client.mutation(api.core.together.join, { domain: "movies", link });

    const queued = await inOrder(items, async (item) => (await add(item, "end")).entryId);
    const queue = queueOf(viewer);
    const mark = await logMark(stack);
    const pages = await queue.all();
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

    const reloaded = await queue.between(null, firstPage.continueCursor);

    expect(reloaded.map((entry) => entry.entryId)).toEqual([
      ...ahead.toReversed(),
      ...firstPage.page.map((entry) => entry.entryId),
    ]);
    expect(reloaded.every((entry) => entry.item !== null)).toBe(true);

    const reads = (await usageSince(stack, mark, api.core.together.queue, queue.calls()))
      .filter((call) => call.committed)
      .map((call) => call.reads);

    process.stdout.write(
      `queue of ${LIBRARIES} libraries for a viewer in ${groups.length} groups: ` +
        `${firstPage.page.length} entries a page, reads per call ${reads.join(", ")}\n`,
    );

    expect(Math.max(...reads)).toBeLessThanOrEqual(PAGE_ROWS_MAX);
  });
});
