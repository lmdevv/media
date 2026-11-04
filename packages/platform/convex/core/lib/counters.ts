import type { DatabaseReader, DatabaseWriter } from "../../_generated/server";

/**
 * Each increment writes one shard picked at random, so concurrent increments of one set rarely
 * touch the same row. With one row, 20 concurrent increments exhausted Convex's conflict retries
 * in about one run of ten.
 */
export const COUNTER_SHARDS = 16;

export const readCounter = async (db: DatabaseReader, name: string): Promise<number> => {
  const shards = await db
    .query("counters")
    .withIndex("by_name_shard", (q) => q.eq("name", name))
    .collect();

  return shards.reduce((total, shard) => total + shard.value, 0);
};

/**
 * Adds `delta` to the set `name` counts. Call it in the mutation that writes the counted rows, so
 * the count commits or rolls back with them, and pass a negative `delta` only for rows that call
 * removes.
 *
 * @throws Error when `delta` is not a safe integer.
 */
export const incrementCounter = async (
  db: DatabaseWriter,
  name: string,
  delta: number,
): Promise<void> => {
  if (!Number.isSafeInteger(delta)) {
    throw new Error(`Counter ${name} takes whole steps; got ${delta}`);
  }

  const shard = Math.floor(Math.random() * COUNTER_SHARDS);

  // Two calls in one mutation can both find this shard missing and insert it twice. readCounter
  // sums every row, so a second row for a shard splits its value and the total stays right.
  const row = await db
    .query("counters")
    .withIndex("by_name_shard", (q) => q.eq("name", name).eq("shard", shard))
    .first();

  if (row === null) {
    await db.insert("counters", { name, shard, value: delta });
  } else {
    await db.patch(row._id, { value: row.value + delta });
  }
};
