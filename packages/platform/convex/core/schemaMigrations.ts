/**
 * Data migrations: rewrites of stored rows that a new version needs and a schema change cannot
 * do. Music's cursor runner, ported (ADR 0012), with one registry, `MIGRATIONS`.
 *
 * Each migration walks one table in batches inside the per-call limits and saves its cursor after
 * every batch, so a stopped chain resumes where it stopped. Every batch is idempotent: it computes
 * each row's target and writes only rows that differ. Changing what a migration computes needs a
 * new name, or deployments that finished the old one never rewrite their rows.
 *
 * `scripts/dev-stack.sh` calls `run` after it deploys the core. A deploy mid-chain therefore calls
 * `run` while the chain's next `step` is scheduled; both steps start from the saved cursor, and
 * exactly one advances (see `step`). Scheduled steps survive a backend restart.
 */
import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";

interface Batch {
  readonly continueCursor: string;
  readonly isDone: boolean;
}

interface SchemaMigration<Name extends string> {
  readonly name: Name;
  /** One batch from `cursor`, null for the first. Must stay inside the per-call limits. */
  readonly batch: (ctx: MutationCtx, cursor: string | null) => Promise<Batch>;
}

const defineMigration = <const Name extends string>(
  name: Name,
  batch: SchemaMigration<Name>["batch"],
): SchemaMigration<Name> => ({ name, batch });

/** Rows one probe batch reads, and at most writes. */
const PROBE_BATCH = 1000;

const MIGRATIONS = [
  /**
   * Probe, for the stack suite, like `limitsProbe`: sets `doubled = position * 2` on every
   * `limitsProbeRows` row. That table is empty in production, so this finishes in one batch there.
   */
  defineMigration("probe.doublePositions", async (ctx, cursor) => {
    const page = await ctx.db.query("limitsProbeRows").paginate({ cursor, numItems: PROBE_BATCH });

    await Promise.all(
      page.page.map(async (row) => {
        const doubled = row.position * 2;

        if (row.doubled !== doubled) await ctx.db.patch("limitsProbeRows", row._id, { doubled });
      }),
    );

    return page;
  }),
] as const;

type MigrationName = (typeof MIGRATIONS)[number]["name"];

const migrationName = v.union(...MIGRATIONS.map((migration) => v.literal(migration.name)));

const batches = new Map(MIGRATIONS.map((migration) => [migration.name, migration.batch] as const));

const progressOf = (db: DatabaseReader, name: MigrationName) =>
  db
    .query("schemaMigrations")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();

/**
 * Starts every migration that has not finished, from its saved cursor, and says what it did for
 * each. Safe to run any number of times: a finished migration is skipped, and a duplicate of a
 * chain in flight stops at its first step.
 */
export const run = internalMutation({
  args: {},
  returns: v.array(
    v.union(
      v.object({ name: migrationName, state: v.literal("done") }),
      v.object({
        name: migrationName,
        state: v.literal("scheduled"),
        /** Where the chain starts: null for a fresh start, else where it resumes. */
        cursor: v.union(v.string(), v.null()),
      }),
    ),
  ),
  handler: (ctx) =>
    Promise.all(
      MIGRATIONS.map(async ({ name }) => {
        const progress = await progressOf(ctx.db, name);

        if (progress?.done === true) return { name, state: "done" as const };

        if (progress === null) {
          await ctx.db.insert("schemaMigrations", { name, cursor: null, done: false });
        }

        const cursor = progress?.cursor ?? null;

        await ctx.scheduler.runAfter(0, internal.core.schemaMigrations.step, { name, cursor });

        return { name, state: "scheduled" as const, cursor };
      }),
    ),
});

/**
 * Runs one batch of `name` and schedules the next, only when `cursor` is the saved one, so of two
 * chains from the same point exactly one advances (Convex mutations are serializable).
 */
export const step = internalMutation({
  args: { name: migrationName, cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { name, cursor }) => {
    const progress = await progressOf(ctx.db, name);

    if (progress === null || progress.done || progress.cursor !== cursor) return null;

    const batchFrom = batches.get(name);

    if (batchFrom === undefined) throw new Error(`No schema migration ${name}`);

    const batch = await batchFrom(ctx, cursor);

    await ctx.db.patch("schemaMigrations", progress._id, {
      cursor: batch.continueCursor,
      done: batch.isDone,
    });

    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.core.schemaMigrations.step, {
        name,
        cursor: batch.continueCursor,
      });
    }

    return null;
  },
});

export const status = internalQuery({
  args: { name: migrationName },
  returns: v.union(
    v.null(),
    v.object({ cursor: v.union(v.string(), v.null()), done: v.boolean() }),
  ),
  handler: async (ctx, { name }) => {
    const progress = await progressOf(ctx.db, name);

    return progress === null ? null : { cursor: progress.cursor, done: progress.done };
  },
});

/**
 * Probe only: sets the probe migration back to not started, so a repeat stack-suite run watches
 * it run again. A non-probe name fails argument validation.
 */
export const resetProbe = internalMutation({
  args: { name: v.literal("probe.doublePositions") },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    const progress = await progressOf(ctx.db, name);

    if (progress !== null) await ctx.db.delete("schemaMigrations", progress._id);

    return null;
  },
});
