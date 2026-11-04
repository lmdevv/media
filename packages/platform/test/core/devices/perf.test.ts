import { afterAll, describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { logMark, usageSince } from "../../admin";
import { anonymous, listings, member, openTile, sharedDevice, sharedTiles } from "../../devices";
import { refusal } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const LISTED = 20;

const KIDS = 2;

const CODES = 10;

const CALLS = 200;

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Number.NaN;

const listed = listings();

describe.skipIf(stack === undefined)("a shared device's picker", { timeout: 600_000 }, () => {
  afterAll(async () => {
    await listed.clear();
  });

  it("reads a bounded number of documents with 20 people listed", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "admin", "admin");

    const adults = await inOrder(
      Array.from({ length: LISTED - KIDS }, (_, n) => n),
      async (n) => listed.adult(await member(stack, `perf-adult-${n}`)),
    );

    const kids = await inOrder(
      Array.from({ length: KIDS }, (_, n) => n),
      async (n) => listed.kid(admin, await member(stack, `perf-kid-${n}`)),
    );

    await inOrder(
      adults.slice(0, CODES).map((adult, n) => ({ adult, code: `${4000 + n}` })),
      async ({ adult, code }) =>
        adult.signedIn.client.action(api.core.devices.unlockCodes.set, { code }),
    );

    const tv = await sharedDevice(stack, admin);
    const [first] = adults;

    if (first === undefined || kids[0] === undefined) throw new Error("seeded no one");

    expect(
      await refusal(
        openTile(stack, tv, first.userId, { kind: "code", by: first.userId, code: "0000" }),
      ),
    ).toBe("unauthenticated");

    await openTile(stack, tv, kids[0].userId);

    const client = anonymous(stack);
    const mark = await logMark(stack);

    // Each call names the device with its own leading spaces, which the core trims, so no call
    // is served from the query cache.
    const timings = await inOrder(
      Array.from({ length: CALLS }, (_, n) => n),
      async (n) => {
        const started = performance.now();

        const shown = await client.query(api.core.devices.picker.show, {
          device: `${" ".repeat(n)}${tv.device}`,
        });

        return { ms: performance.now() - started, tiles: sharedTiles(shown).length };
      },
    );

    const usage = (await usageSince(stack, mark, api.core.devices.picker.show, CALLS)).filter(
      (call) => call.committed,
    );

    const reads = usage.map((call) => call.reads);
    const p50 = median(timings.map((call) => call.ms));

    process.stdout.write(
      `shared picker over ${LISTED} listed people: p50 ${p50.toFixed(1)} ms per call, ` +
        `reads p50 ${median(reads)} max ${Math.max(...reads)} over ${reads.length} uncached calls\n`,
    );

    expect(timings.every((call) => call.tiles >= LISTED)).toBe(true);
    expect(reads.length).toBeGreaterThanOrEqual(CALLS);
    expect(Math.max(...reads)).toBeLessThanOrEqual(2 + 3 * LISTED);
  });
});
