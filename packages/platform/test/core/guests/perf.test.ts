import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { OPENS_PER_LINK_PER_HOUR } from "../../../convex/core/guests/model";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { logMark, usageSince } from "../../admin";
import { member } from "../../devices";
import { guestsOn, makeLink, openLink } from "../../guests";
import { movie, seedLibrary } from "../../probe";
import { signIn, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const OPENS = 100;

const LINKS = Math.ceil((OPENS + 1) / OPENS_PER_LINK_PER_HOUR);

const PER_LINK = Math.ceil(OPENS / LINKS);

const BUDGET_MS = 150;

const median = (values: ReadonlyArray<number>): number =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Number.NaN;

describe.skipIf(stack === undefined)("opening guest links", { timeout: 600_000 }, () => {
  it(`opens a link at p50 under ${BUDGET_MS} ms over ${OPENS} opens`, async () => {
    if (stack === undefined) return;

    await guestsOn(stack);

    const admin = await member(stack, "perf-maker", "admin");

    const films = await seedLibrary(stack, admin, {
      name: `perf-${unique()}`,
      kind: "movies",
      items: [movie("shared.mkv", 0)],
    });

    const [id] = films.itemIds;

    if (id === undefined) throw new Error("seeded no item");

    const target = {
      kind: "item",
      item: { domain: "movies", ref: { type: "probeMovie", id } },
    } as const;

    const links = await inOrder(
      Array.from({ length: LINKS }, (_, n) => n),
      async () => makeLink(admin, target),
    );

    await openLink(stack, links[0]?.code ?? "", "Warm-up");

    const timings = await inOrder(
      Array.from({ length: OPENS }, (_, n) => n),
      async (n) => {
        const code = links[Math.floor(n / PER_LINK)]?.code ?? "";
        const started = performance.now();

        await signIn(stack, "guest", { code, name: `Guest ${n}` });

        return performance.now() - started;
      },
    );

    const guest = await openLink(stack, links.at(-1)?.code ?? "", "Reader");
    const mark = await logMark(stack);

    await guest.signedIn.client.query(api.core.guests.current, {});

    const current = (await usageSince(stack, mark, api.core.guests.current, 1)).find(
      (call) => call.committed,
    );

    const p50 = median(timings);

    process.stdout.write(
      `guest link open over ${OPENS} opens: p50 ${p50.toFixed(1)} ms, ` +
        `p95 ${timings.toSorted((a, b) => a - b)[Math.floor(OPENS * 0.95)]?.toFixed(1)} ms; ` +
        `a guest's core.guests.current read ${current?.reads ?? Number.NaN} documents\n`,
    );

    expect(p50).toBeLessThan(BUDGET_MS);
    expect(current?.reads ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(12);
  });
});
