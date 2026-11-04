import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { logMark, usageSince } from "../../admin";
import { movie, probePage, seedProbes, sessionOf, shareProbe } from "../../probe";
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

describe.skipIf(stack === undefined)("a grant-checked list", { timeout: 600_000 }, () => {
  it("reads a bounded page however many grants the table holds", async () => {
    if (stack === undefined) return;
    const admin = await signInAs(stack, await createPerson(stack, "admin", "admin"));
    const manager = await sessionOf(await signInAs(stack, await createPerson(stack, "manager")));
    const viewer = await sessionOf(await signInAs(stack, await createPerson(stack, "viewer")));

    const probes = await seedProbes(
      stack,
      manager,
      Array.from({ length: GRANTS }, (_, n) => movie(`perf-${n}`, n % 19)),
    );

    const { groupId } = await admin.client.mutation(api.core.permissions.groups.create, {
      name: `perf-${unique()}`,
    });

    await admin.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: viewer.userId,
    });

    await inOrder(probes.slice(0, 60), async (probeId) =>
      shareProbe(stack, manager, probeId, { kind: "user", userId: viewer.userId }, "view"),
    );
    await inOrder(probes.slice(40, 100), async (probeId) =>
      shareProbe(stack, manager, probeId, { kind: "group", groupId }, "edit"),
    );

    const mark = await logMark(stack);

    const timings = await inOrder(
      Array.from({ length: CALLS }, (_, n) => n),
      async (n) => {
        const started = performance.now();
        const page = await probePage(stack, viewer, PAGE, null, n);

        return { ms: performance.now() - started, rows: page.page.length };
      },
    );

    const reads = (await usageSince(stack, mark, internal.core.permissions.probe.list, CALLS))
      .filter((call) => call.committed)
      .map((call) => call.reads);

    process.stdout.write(
      `grant-checked list over ${GRANTS}+ grants: p50 ${median(timings.map((call) => call.ms)).toFixed(1)} ms per call, ` +
        `reads p50 ${median(reads)} max ${Math.max(...reads)} over ${reads.length} calls\n`,
    );

    expect(timings.every((call) => call.rows === PAGE)).toBe(true);
    expect(reads.length).toBeGreaterThanOrEqual(CALLS);
    expect(Math.max(...reads)).toBeLessThan(CALL_READS_MAX);
  });
});
