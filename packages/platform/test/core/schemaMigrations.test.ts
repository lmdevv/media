import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { internal } from "../../convex/_generated/api";
import { followLog, logMark, runFunction } from "../admin";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { eventually, freshRun, inSequence } from "./jobs/driver";

const stack = coreStackFromEnvFile();

const ROWS = 40_000;

const SEED_ROWS = 8000;

const STEP_ROWS = 500;

const PAGE_ROWS = 1000;

const GROUP_PREFIX = "migrate-";

const name = "probe.doublePositions";

const Started = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    state: Schema.Literals(["done", "scheduled"]),
    cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

const Status = Schema.NullOr(
  Schema.Struct({ cursor: Schema.NullOr(Schema.String), done: Schema.Boolean }),
);

const Page = Schema.Struct({
  page: Schema.Array(
    Schema.Struct({ position: Schema.Finite, doubled: Schema.optionalKey(Schema.Finite) }),
  ),
  isDone: Schema.Boolean,
  continueCursor: Schema.String,
});

const run = (core: CoreStack) => runFunction(core, internal.core.schemaMigrations.run, {}, Started);

const unmigrated = async (
  core: CoreStack,
  group: string,
  cursor: string | null = null,
  rows = 0,
  wrong = 0,
): Promise<{ readonly rows: number; readonly wrong: number }> => {
  const result = await runFunction(
    core,
    internal.core.limitsProbe.page,
    { group, paginationOpts: { numItems: PAGE_ROWS, cursor } },
    Page,
  );

  const counted = {
    rows: rows + result.page.length,
    wrong: wrong + result.page.filter((row) => row.doubled !== row.position * 2).length,
  };

  return result.isDone
    ? counted
    : unmigrated(core, group, result.continueCursor, counted.rows, counted.wrong);
};

const clearMigrateRows = async (core: CoreStack, cursor: string | null = null): Promise<void> => {
  const page = await runFunction(
    core,
    internal.core.limitsProbe.clear,
    { groupPrefix: GROUP_PREFIX, cursor },
    Schema.Struct({ continueCursor: Schema.String, isDone: Schema.Boolean }),
  );

  if (!page.isDone) await clearMigrateRows(core, page.continueCursor);
};

describe.skipIf(stack === undefined)("core schema migrations, live", { timeout: 300_000 }, () => {
  it("migrates 40,000 rows in batches, and a second run mid-chain does not double the chain", async () => {
    if (stack === undefined) return;

    await clearMigrateRows(stack);

    const group = freshRun(GROUP_PREFIX.slice(0, -1));

    await inSequence(
      Array.from({ length: ROWS / SEED_ROWS }, (_, n) => n * SEED_ROWS),
      (from) =>
        runFunction(
          stack,
          internal.core.limitsProbe.seed,
          { group, from, rows: SEED_ROWS },
          Schema.Null,
        ),
    );
    await runFunction(stack, internal.core.schemaMigrations.resetProbe, { name }, Schema.Null);

    const mark = await logMark(stack);
    const log = followLog(stack, mark);

    expect(await run(stack)).toContainEqual({ name, state: "scheduled", cursor: null });
    expect(await run(stack)).toContainEqual(expect.objectContaining({ name, state: "scheduled" }));

    await eventually(
      "the probe migration to finish",
      async () => {
        await log.catchUp();

        const status = await runFunction(
          stack,
          internal.core.schemaMigrations.status,
          { name },
          Status,
        );

        return status?.done === true ? status : null;
      },
      240_000,
    );

    expect(await run(stack)).toContainEqual({ name, state: "done" });
    expect(await unmigrated(stack, group)).toEqual({ rows: ROWS, wrong: 0 });

    await log.catchUp();

    const steps = log.usage(internal.core.schemaMigrations.step);
    const committed = steps.filter((call) => call.committed);
    const stopped = committed.filter((call) => call.writes === 0);

    expect(stopped).toHaveLength(1);
    expect(committed.length - stopped.length).toBeGreaterThanOrEqual(ROWS / STEP_ROWS);
    expect(Math.max(...steps.map((call) => call.writes))).toBeLessThanOrEqual(STEP_ROWS + 1);

    await clearMigrateRows(stack);
  });
});
