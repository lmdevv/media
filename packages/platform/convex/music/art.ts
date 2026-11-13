import { v } from "convex/values";

import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { serverQuery } from "../core/lib/serverFacing";

/**
 * Hashes one `inUse` call checks at most, as old music's `artInUse` did: each costs three index
 * ranges and at most a track, an album, and an artist at their bounds, about 9 MiB for 200.
 */
const IN_USE_MAX = 200;

/** Distinct hashes one `hashes` page lists: one index range and one document at its bound each. */
const HASHES_PAGE = 200;

type ArtTable = "tracks" | "albums" | "artists";

const firstWith = (db: DatabaseReader, table: ArtTable, hash: string) =>
  db
    .query(table)
    .withIndex("by_art", (q) => q.eq("artHash", hash))
    .first();

/**
 * Which of up to 200 artwork hashes a track, album, or artist of any library still uses, so the
 * server deletes the artwork a scan released (`released` in the scanner's answers) without
 * listing every hash in use. Artwork is stored once for every library, so this reads them all.
 * Refuses more than 200 with `invalid_args`.
 */
export const inUse = serverQuery({
  args: { hashes: v.array(v.string()) },
  returns: v.object({ inUse: v.array(v.string()) }),
  handler: async (ctx, { hashes }) => {
    if (hashes.length > IN_USE_MAX) {
      return fail("invalid_args", `Check at most ${IN_USE_MAX} hashes at once`);
    }

    const used = await Promise.all(
      hashes.map(async (hash) =>
        (
          await Promise.all(
            (["tracks", "albums", "artists"] as const).map(async (table) =>
              firstWith(ctx.db, table, hash),
            ),
          )
        ).some((row) => row !== null),
      ),
    );

    return { inUse: hashes.filter((_, index) => used[index] === true) };
  },
});

/**
 * One page of the distinct artwork hashes the tracks, albums, or artists of every library use,
 * after `cursor`, the last hash of the page before, so the server deletes stored artwork nothing
 * uses any more. Walk each table from a null cursor until `done`. Each hash is read once however
 * many rows use it, so the cursor is exact.
 */
export const hashes = serverQuery({
  args: {
    table: v.union(v.literal("tracks"), v.literal("albums"), v.literal("artists")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ hashes: v.array(v.string()), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { table, cursor }) => {
    const after = async (
      from: string,
      found: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<string>> => {
      if (found.length === HASHES_PAGE) return found;

      const next = await ctx.db
        .query(table)
        .withIndex("by_art", (q) => q.gt("artHash", from))
        .first();

      const hash = next?.artHash ?? null;

      return hash === null ? found : after(hash, [...found, hash]);
    };

    const found = await after(cursor ?? "", []);
    const last = found.at(-1);

    return {
      hashes: [...found],
      cursor: last ?? cursor ?? "",
      done: found.length < HASHES_PAGE,
    };
  },
});
