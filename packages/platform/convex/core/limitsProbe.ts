import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { PaginationResult } from "convex/server";
import { v } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { incrementCounter, readCounter } from "./lib/counters";
import { paginate } from "./lib/paginate";

/** Most rows one `seed` call adds, inside the 16,000 documents one call may write (ADR 0013). */
const SEED_ROWS_MAX = 8000;

const counterName = (group: string): string => `limitsProbe:${group}`;

const probeRow = v.object({
  _id: v.id("limitsProbeRows"),
  _creationTime: v.number(),
  group: v.string(),
  position: v.number(),
  doubled: v.optional(v.number()),
});

export const seed = internalMutation({
  args: { group: v.string(), from: v.number(), rows: v.number() },
  returns: v.null(),
  handler: async (ctx, { group, from, rows }) => {
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > SEED_ROWS_MAX) {
      throw new Error(`seed adds 1 to ${SEED_ROWS_MAX} rows; got ${rows}`);
    }

    await Promise.all(
      Array.from({ length: rows }, (_, offset) =>
        ctx.db.insert("limitsProbeRows", { group, position: from + offset }),
      ),
    );

    await incrementCounter(ctx.db, counterName(group), rows);

    return null;
  },
});

export const add = internalMutation({
  args: { group: v.string(), position: v.number() },
  returns: v.null(),
  handler: async (ctx, { group, position }) => {
    await ctx.db.insert("limitsProbeRows", { group, position });
    await incrementCounter(ctx.db, counterName(group), 1);

    return null;
  },
});

/** Most rows one `clear` call deletes. */
const CLEAR_ROWS_MAX = 1000;

/**
 * Deletes up to 1,000 rows of the groups whose name starts with `groupPrefix`, from `cursor`, so a
 * lane that seeds many rows leaves the table no larger. The caller passes back `continueCursor`
 * until `isDone`; resuming after the deleted rows keeps each call from rescanning them.
 */
export const clear = internalMutation({
  args: { groupPrefix: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { groupPrefix, cursor }) => {
    const page = await paginate(
      ctx.db,
      {
        table: "limitsProbeRows",
        index: "by_group_position",
        range: (q) => q.gte("group", groupPrefix).lt("group", `${groupPrefix}\uffff`),
      },
      { cursor, numItems: CLEAR_ROWS_MAX },
    );

    await Promise.all(page.page.map((row) => ctx.db.delete("limitsProbeRows", row._id)));

    return { continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const count = internalQuery({
  args: { group: v.string() },
  returns: v.number(),
  handler: (ctx, { group }) => readCounter(ctx.db, counterName(group)),
});

export const page = internalQuery({
  args: { group: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(probeRow),
  handler: (ctx, { group, paginationOpts }): Promise<PaginationResult<Doc<"limitsProbeRows">>> =>
    paginate(
      ctx.db,
      {
        table: "limitsProbeRows",
        index: "by_group_position",
        range: (q) => q.eq("group", group),
      },
      paginationOpts,
    ),
});
