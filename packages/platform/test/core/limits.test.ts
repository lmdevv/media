import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { internal } from "../../convex/_generated/api";
import { COUNTER_SHARDS } from "../../convex/core/lib/counters";
import { PAGE_ROWS_MAX } from "../../convex/core/lib/paginate";
import { logMark, runFunction, usageSince } from "../admin";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";

const stack = coreStackFromEnvFile();

const Page = Schema.Struct({
  page: Schema.Array(Schema.Struct({ position: Schema.Finite })),
  isDone: Schema.Boolean,
  continueCursor: Schema.String,
});

const freshGroup = (label: string): string => `${label}-${Math.random().toString(36).slice(2, 8)}`;

const countOf = async (core: CoreStack, group: string): Promise<number> =>
  runFunction(core, internal.core.limitsProbe.count, { group }, Schema.Finite);

const pageThrough = async (
  core: CoreStack,
  group: string,
  numItems: number,
  cursor: string | null = null,
  positions: ReadonlyArray<number> = [],
  pages = 0,
): Promise<{ readonly positions: ReadonlyArray<number>; readonly pages: number }> => {
  const result = await runFunction(
    core,
    internal.core.limitsProbe.page,
    { group, paginationOpts: { numItems, cursor } },
    Page,
  );

  const next = [...positions, ...result.page.map((row) => row.position)];

  return result.isDone
    ? { positions: next, pages: pages + 1 }
    : pageThrough(core, group, numItems, result.continueCursor, next, pages + 1);
};

const range = (length: number): ReadonlyArray<number> => Array.from({ length }, (_, n) => n);

describe.skipIf(stack === undefined)("core limits", { timeout: 120_000 }, () => {
  it("pages through every row once and reads no more than one page per call", async () => {
    if (stack === undefined) return;

    const group = freshGroup("pages");

    await runFunction(
      stack,
      internal.core.limitsProbe.seed,
      { group, from: 0, rows: 250 },
      Schema.Null,
    );

    const mark = await logMark(stack);
    const { positions, pages } = await pageThrough(stack, group, 25);

    const reads = (await usageSince(stack, mark, internal.core.limitsProbe.page, pages)).map(
      (call) => call.reads,
    );

    expect(positions).toEqual(range(250));
    expect(Math.max(...reads)).toBeLessThanOrEqual(25);
  });

  it("holds a page to the most rows a page may hold, whatever the caller asks", async () => {
    if (stack === undefined) return;

    const group = freshGroup("cap");

    await runFunction(
      stack,
      internal.core.limitsProbe.seed,
      { group, from: 0, rows: PAGE_ROWS_MAX + 500 },
      Schema.Null,
    );

    const mark = await logMark(stack);

    const first = await runFunction(
      stack,
      internal.core.limitsProbe.page,
      { group, paginationOpts: { numItems: 50_000, cursor: null } },
      Page,
    );

    const reads = (await usageSince(stack, mark, internal.core.limitsProbe.page, 1)).map(
      (call) => call.reads,
    );

    expect(first.page).toHaveLength(PAGE_ROWS_MAX);
    expect(first.isDone).toBe(false);
    expect(Math.max(...reads)).toBeLessThanOrEqual(PAGE_ROWS_MAX);
  });

  it("reads a total from a few counter documents, however large the set", async () => {
    if (stack === undefined) return;

    const group = freshGroup("total");

    expect(await countOf(stack, group)).toBe(0);

    await runFunction(
      stack,
      internal.core.limitsProbe.seed,
      { group, from: 0, rows: 1000 },
      Schema.Null,
    );
    await runFunction(
      stack,
      internal.core.limitsProbe.seed,
      { group, from: 1000, rows: 200 },
      Schema.Null,
    );

    const mark = await logMark(stack);
    const total = await countOf(stack, group);

    const reads = (await usageSince(stack, mark, internal.core.limitsProbe.count, 1)).map(
      (call) => call.reads,
    );

    expect(total).toBe(1200);
    expect(Math.max(...reads)).toBeLessThanOrEqual(COUNTER_SHARDS);
  });

  it("counts every one of 20 concurrent adds to one counter", async () => {
    if (stack === undefined) return;

    const group = freshGroup("race");

    await Promise.all(
      range(20).map((position) =>
        runFunction(stack, internal.core.limitsProbe.add, { group, position }, Schema.Null),
      ),
    );

    const { positions } = await pageThrough(stack, group, 100);

    expect(await countOf(stack, group)).toBe(20);
    expect(positions).toEqual(range(20));
  });
});
