/**
 * A library's counters live in their own `libraryStats` row. Every request reads every library
 * row to decide what the viewer may read, so counters on that row made every open query of every
 * user run again with each batch a scan saved. Older versions kept the counters on the library;
 * readers fall back to those until the first count change or the `splitLibraryStats` migration
 * moves them.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./viewer";

/** Playable songs, albums with songs, artists with albums, and the songs' total length. */
export interface LibraryCounts {
  readonly trackCount: number;
  readonly albumCount: number;
  readonly artistCount: number;
  readonly durationMs: number;
}

/** A change to apply to a library's counters. */
export interface CountsDelta {
  readonly tracks: number;
  readonly albums: number;
  readonly artists: number;
  readonly durationMs: number;
}

/** The counters of a library that has none yet. */
export const EMPTY_COUNTS: LibraryCounts = {
  trackCount: 0,
  albumCount: 0,
  artistCount: 0,
  durationMs: 0,
};

/** Clears the counters older versions kept on the library row. */
export const clearedLegacyCounts = {
  trackCount: undefined,
  albumCount: undefined,
  artistCount: undefined,
  durationMs: undefined,
} as const;

/** Whether a library row still carries the counters older versions kept on it. */
export const hasLegacyCounts = (library: Doc<"libraries">): boolean =>
  library.trackCount !== undefined ||
  library.albumCount !== undefined ||
  library.artistCount !== undefined ||
  library.durationMs !== undefined;

const legacyCounts = (library: Doc<"libraries">): LibraryCounts => ({
  trackCount: library.trackCount ?? 0,
  albumCount: library.albumCount ?? 0,
  artistCount: library.artistCount ?? 0,
  durationMs: library.durationMs ?? 0,
});

/** A library's counters row, if one was written yet. */
export const findStats = (
  ctx: ReadCtx,
  libraryId: Id<"libraries">,
): Promise<Doc<"libraryStats"> | null> =>
  ctx.db
    .query("libraryStats")
    .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
    .unique();

const countsOf = (row: Doc<"libraryStats">): LibraryCounts => ({
  trackCount: row.trackCount,
  albumCount: row.albumCount,
  artistCount: row.artistCount,
  durationMs: row.durationMs,
});

/** A library's counters, from its stats row or, before that exists, from the library row. */
export const libraryCounts = async (
  ctx: ReadCtx,
  library: Doc<"libraries">,
): Promise<LibraryCounts> => {
  const row = await findStats(ctx, library._id);

  return row === null ? legacyCounts(library) : countsOf(row);
};

const applied = (counts: LibraryCounts, delta: CountsDelta): LibraryCounts => ({
  trackCount: Math.max(0, counts.trackCount + delta.tracks),
  albumCount: Math.max(0, counts.albumCount + delta.albums),
  artistCount: Math.max(0, counts.artistCount + delta.artists),
  durationMs: Math.max(0, counts.durationMs + delta.durationMs),
});

/** Gives a library whose counters are on its own row (as older versions kept them) a stats row. */
const moveLegacyCounts = async (
  ctx: MutationCtx,
  library: Doc<"libraries">,
  counts: LibraryCounts,
): Promise<void> => {
  await ctx.db.insert("libraryStats", { libraryId: library._id, ...counts });

  if (hasLegacyCounts(library)) await ctx.db.patch(library._id, clearedLegacyCounts);
};

/**
 * Moves the counters an older version kept on the library row to a stats row, unless one exists
 * (it is newer, and the library row's are stale), and clears them from the library.
 */
export const splitLegacyCounts = async (
  ctx: MutationCtx,
  library: Doc<"libraries">,
): Promise<void> => {
  if ((await findStats(ctx, library._id)) === null) {
    await moveLegacyCounts(ctx, library, legacyCounts(library));
  } else if (hasLegacyCounts(library)) {
    await ctx.db.patch(library._id, clearedLegacyCounts);
  }
};

/** Adds `delta` to a library's counters, moving them off the library row on first use. */
export const bumpLibraryCounts = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  delta: CountsDelta,
): Promise<void> => {
  const row = await findStats(ctx, libraryId);

  if (row !== null) {
    await ctx.db.patch(row._id, applied(countsOf(row), delta));

    return;
  }

  const library = await ctx.db.get(libraryId);

  if (library !== null) await moveLegacyCounts(ctx, library, applied(legacyCounts(library), delta));
};
