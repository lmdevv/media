import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { logMark, usageSince } from "../../admin";
import { enroll, member } from "../../devices";
import { signInAs } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const CALLS = 200;

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Number.NaN;

describe.skipIf(stack === undefined)("reading settings", { timeout: 600_000 }, () => {
  it("reads a bounded number of documents and reports the median latency", async () => {
    if (stack === undefined) return;

    const person = await member(stack, "perf-settings");
    const phone = await signInAs(stack, person.person);

    await enroll(phone, "Phone");
    await phone.client.mutation(api.core.settings.set, { subtitleLanguage: "fr", crossfade: 3 });

    const mark = await logMark(stack);

    // An untimed write before each read changes the rows the read depends on, so no read is
    // served from the query cache.
    const timings = await inOrder(
      Array.from({ length: CALLS }, (_, n) => n),
      async (n) => {
        await phone.client.mutation(api.core.settings.set, { volume: (n % 100) / 100 });

        const started = performance.now();
        const shown = await phone.client.query(api.core.settings.get, {});

        return { ms: performance.now() - started, volume: shown.device?.volume };
      },
    );

    const usage = (await usageSince(stack, mark, api.core.settings.get, CALLS)).filter(
      (call) => call.committed,
    );

    const reads = usage.map((call) => call.reads);
    const p50 = median(timings.map((call) => call.ms));

    process.stdout.write(
      `settings get over ${CALLS} uncached calls: p50 ${p50.toFixed(1)} ms, ` +
        `reads p50 ${median(reads)} max ${Math.max(...reads)} over ${reads.length} calls\n`,
    );

    expect(timings.map((call) => call.volume)).toEqual(
      Array.from({ length: CALLS }, (_, n) => (n % 100) / 100),
    );
    expect(reads.length).toBeGreaterThanOrEqual(CALLS);
    expect(Math.max(...reads)).toBeLessThanOrEqual(6);
  });
});
