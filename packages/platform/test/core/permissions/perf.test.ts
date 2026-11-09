import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { logMark, usageSince } from "../../admin";
import { seedLibraries, sessionOf, share } from "../../probe";
import { createPerson, signInAs, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const GRANTS = 1000;

const CALLS = 200;

const PAGE = 50;

/** The most documents one Convex call may read (ADR 0013). */
const CALL_READS_MAX = 32_000;

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Number.NaN;

describe.skipIf(stack === undefined)("the library list", { timeout: 600_000 }, () => {
  it("reads a bounded page however many grants the table holds", async () => {
    if (stack === undefined) return;
    const admin = await signInAs(stack, await createPerson(stack, "admin", "admin"));
    const manager = await sessionOf(await signInAs(stack, await createPerson(stack, "manager")));
    const viewer = await sessionOf(await signInAs(stack, await createPerson(stack, "viewer")));

    const half = Array.from({ length: GRANTS / 2 }, (_, n) => n);

    const films = await seedLibraries(
      stack,
      manager,
      half.map((n) => ({ name: `perf-${2 * n}`, kind: "movies", items: [] })),
    );

    const songs = await seedLibraries(
      stack,
      manager,
      half.map((n) => ({ name: `perf-${2 * n + 1}`, kind: "music", items: [] })),
    );

    const libraries = [...films, ...songs].map((seeded) => seeded.libraryId);

    const { groupId } = await admin.client.mutation(api.core.permissions.groups.create, {
      name: `perf-${unique()}`,
    });

    await admin.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: viewer.userId,
    });

    await inOrder(libraries.slice(0, 60), async (libraryId) =>
      share(manager, libraryId, { kind: "user", userId: viewer.userId }, "view"),
    );
    await inOrder(libraries.slice(40, 100), async (libraryId) =>
      share(manager, libraryId, { kind: "group", groupId }, "edit"),
    );

    const mark = await logMark(stack);

    const timings = await inOrder(
      Array.from({ length: CALLS }, (_, n) => n),
      async (n) => {
        const started = performance.now();

        const page = await viewer.signedIn.client.query(api.core.libraries.list, {
          paginationOpts: { numItems: PAGE, cursor: null, id: n },
        });

        return { ms: performance.now() - started, rows: page.page.length };
      },
    );

    const reads = (await usageSince(stack, mark, api.core.libraries.list, CALLS))
      .filter((call) => call.committed)
      .map((call) => call.reads);

    process.stdout.write(
      `library list over ${GRANTS}+ grants: p50 ${median(timings.map((call) => call.ms)).toFixed(1)} ms per call, ` +
        `reads p50 ${median(reads)} max ${Math.max(...reads)} over ${reads.length} calls\n`,
    );

    expect(timings.every((call) => call.rows === PAGE)).toBe(true);
    expect(reads.length).toBeGreaterThanOrEqual(CALLS);
    expect(Math.max(...reads)).toBeLessThan(CALL_READS_MAX);
  });
});
