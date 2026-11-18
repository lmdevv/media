import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PAGE_ROWS_MAX } from "../../../convex/core/lib/paginate";
import { logMark, usageSince } from "../../admin";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { claimJob, moviesLibrary } from "../../movies/catalog";
import type { Lease } from "../../movies/catalog";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { seedLibraries, share, shareThroughEveryGroup } from "../../probe";
import { runServer } from "../../service";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { retrying } from "../jobs/driver";

const stack = coreStackFromEnvFile();

/** The largest page a client asks the library list for: the music apps and the CLI ask for 100. */
const CLIENT_PAGE_MAX = 100;

const Answer = Schema.Struct({ outcome: Schema.String });

const report = (core: CoreStack, lease: Lease, done: number, total: number, message: string) =>
  retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.report,
      { lease, leaseMs: 60_000, message, progress: { done, total } },
      Answer,
    ),
  );

const fail = (core: CoreStack, lease: Lease, error: string) =>
  retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.finish,
      { lease, end: { outcome: "failed", error, retry: false } },
      Answer,
    ),
  );

const listPage = async (who: Member, numItems: number) =>
  who.signedIn.client.query(api.core.libraries.list, {
    paginationOpts: { numItems, cursor: null },
  });

/** `libraryId`'s row on `who`'s library list, as `who` sees it, with `get`'s answer beside it. */
const both = async (who: Member, libraryId: Id<"libraries">) => {
  const listed = (await listPage(who, 1000)).page.find((row) => row.libraryId === libraryId);
  const got = await who.signedIn.client.query(api.core.libraries.get, { libraryId });

  return { listed: listed?.scan, got: got.scan };
};

describe.skipIf(stack === undefined)("the library list's scans", { timeout: 600_000 }, () => {
  it("show each library's latest scan as get shows it to a manager, a viewer, and a kid", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "scans-admin", "admin");
    const viewer = await member(stack, "scans-viewer");
    const kid = await member(stack, "scans-kid");
    const { libraryId, scanJobId } = await moviesLibrary(admin, "Listed scans");

    const [never] = await seedLibraries(stack, admin, [
      { name: "Never scanned", kind: "movies", items: [] },
    ]);

    if (never === undefined) throw new Error("seeded no library");

    await inOrder([viewer, kid], async (who) => {
      await share(admin, libraryId, { kind: "user", userId: who.userId }, "view");
      await share(admin, never.libraryId, { kind: "user", userId: who.userId }, "view");
    });
    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: kid.userId,
      restrictions: {
        maxMovieAge: 7,
        hideUnrated: false,
        hideExplicitMusic: false,
        libraries: null,
      },
    });

    const lease = await claimJob(stack, "movies.scan", scanJobId);

    await report(stack, lease, 1, 4, "probing");

    const running = {
      admin: await both(admin, libraryId),
      viewer: await both(viewer, libraryId),
      kid: await both(kid, libraryId),
    };

    expect(running.admin.listed).toMatchObject({
      jobId: scanJobId,
      status: "running",
      done: 1,
      total: 4,
      message: "probing",
      error: null,
    });
    expect(running.viewer.listed).toMatchObject({ status: "running", done: 1, message: "probing" });
    expect(running.kid.listed).toMatchObject({
      status: "running",
      done: null,
      total: null,
      message: null,
    });

    for (const seen of Object.values(running)) expect(seen.listed).toEqual(seen.got);

    await fail(stack, lease, "The folder went away");

    const failed = {
      admin: await both(admin, libraryId),
      viewer: await both(viewer, libraryId),
      kid: await both(kid, libraryId),
    };

    expect(failed.admin.listed).toMatchObject({
      status: "failed",
      error: "The folder went away",
    });
    expect(failed.viewer.listed).toMatchObject({ status: "failed", error: null });
    expect(failed.kid.listed).toMatchObject({ status: "failed", error: null });

    for (const seen of Object.values(failed)) expect(seen.listed).toEqual(seen.got);

    const unscanned = await inOrder([admin, viewer, kid], async (who) =>
      both(who, never.libraryId),
    );

    expect(unscanned).toEqual(Array.from({ length: 3 }, () => ({ listed: null, got: null })));
  });

  it("read within a page's budget at the largest page a client asks for, every row scanned", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "scans-budget-admin", "admin");
    const manager = await member(stack, "scans-budget-manager");
    const viewer = await member(stack, "scans-budget-viewer");

    const seeded = await seedLibraries(
      stack,
      manager,
      Array.from({ length: CLIENT_PAGE_MAX }, (_, n) => ({
        name: `scans-budget-${n}`,
        kind: "movies",
        items: [],
      })),
    );

    const libraryIds = seeded.map((library) => library.libraryId);

    await inOrder(libraryIds, async (libraryId) =>
      manager.signedIn.client.mutation(api.core.libraries.scan, { libraryId }),
    );

    try {
      await shareThroughEveryGroup(admin, manager, viewer, libraryIds);

      const mark = await logMark(stack);
      const managed = await listPage(manager, CLIENT_PAGE_MAX);
      const shared = await listPage(viewer, CLIENT_PAGE_MAX);

      const scanned = (page: typeof managed) =>
        page.page.filter((row) => libraryIds.includes(row.libraryId));

      const reads = (await usageSince(stack, mark, api.core.libraries.list, 2))
        .filter((call) => call.committed)
        .map((call) => call.reads);

      process.stdout.write(
        `library list of ${CLIENT_PAGE_MAX} scanned libraries: ${managed.page.length} rows in no group, ` +
          `${shared.page.length} in the most groups, reads per call ${reads.join(", ")}\n`,
      );

      expect(managed.page).toHaveLength(CLIENT_PAGE_MAX);
      expect(scanned(managed).length).toBeGreaterThan(0);
      expect(scanned(shared).length).toBeGreaterThan(0);
      // Another suite's claim of a movies scan may fail one of these for good, so any status holds.
      expect(
        [...scanned(managed), ...scanned(shared)].every((row) => row.scan?.jobId !== undefined),
      ).toBe(true);
      expect(Math.max(...reads)).toBeLessThanOrEqual(PAGE_ROWS_MAX);
    } finally {
      await inOrder(libraryIds, async (libraryId) =>
        manager.signedIn.client.mutation(api.core.libraries.remove, { libraryId }),
      );
    }
  });
});
