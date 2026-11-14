import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { purgeStep } from "../core/scans";
import { CALL_COST, NO_COST, cost, meterFrom } from "./budget";
import type { Cost } from "./budget";
import { catalogBatch } from "./catalog";
import { clearDependents } from "./dependents";
import { DOCUMENT_BYTES } from "./fit";
import { dropLookups } from "./lyricLookups";
import { forgetTotals } from "./totals";
import { musicStore } from "./write";

/**
 * Tracks one purge page reads: as many as 8 MiB holds at the track bound, leaving the rest of a
 * call's bytes for their lyrics and the albums and artists they settle.
 */
const TRACKS_PAGE = Math.floor((8 * 1024 * 1024) / DOCUMENT_BYTES.tracks);

/**
 * A page's own work, charged before its first track: the library, its folders and claims, its
 * item count, and its totals at the end (`MusicStore.moveTotals`).
 */
const PAGE_COST = cost(30, 12, 64 * 1024, 4 * 1024);

/** Albums or artists one page of a removed library's last stage deletes. */
const ROWS_PAGE = 200;

/** Where the tracks stage goes next: the same page again when the budget stopped it partway. */
export interface PurgeNext {
  readonly cursor: string | null;
  readonly more: boolean;
  /** Whether the library is gone, so its albums, artists, and totals go once its tracks did. */
  readonly gone: boolean;
}

/**
 * One page of the music purge (ADR 0024): deletes the tracks of a page that no current folder of
 * the library keeps, or every track once the library is gone, with their lyrics, as many as the
 * call's budget admits, through the catalog batch. What people keep of each track (playlist
 * entries, likes, plays, queue entries) goes first, in half the budget (`dependents.ts`), then
 * its queued lyrics lookups, in a quarter (`dropLookups`). The batch settles the albums and artists those
 * tracks filed under in the same mutation: their counts and the library's totals move, and an
 * album left without any track goes, then its artist when nothing files under it. When the budget
 * stops it partway, the next call reads the same page again; the tracks it deleted are gone.
 */
export const tracksPage = (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  cursor: string | null,
  limit: Cost = CALL_COST,
): Promise<PurgeNext> =>
  purgeStep(ctx, libraryId, async (scope) => {
    const store = musicStore(ctx.db, meterFrom(PAGE_COST));

    const found = await store.paginate(
      {
        table: "tracks",
        index: "by_library_path",
        range: (q) => q.eq("libraryId", libraryId),
      },
      { numItems: TRACKS_PAGE, cursor },
    );

    const leaving = found.page.filter((track) => !scope.keeps(track.path));
    const cleared = await dropLookups(ctx, store.meter, await clearDependents(store, leaving));
    const batch = catalogBatch(store, libraryId, { totals: !scope.gone, limit });
    const deleted = await batch.each(cleared, batch.remove);

    const settled = await batch.finish();

    const value: PurgeNext =
      deleted.length < leaving.length
        ? { cursor, more: true, gone: scope.gone }
        : { cursor: found.continueCursor, more: !found.isDone, gone: scope.gone };

    return { value, added: settled.added, removed: settled.removed };
  });

/**
 * The music purge hook (ADR 0024): `tracksPage` until the tracks are done, then, for a removed
 * library, the `rest` stage.
 */
export const tracks = internalMutation({
  args: { libraryId: v.id("libraries"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { libraryId, cursor }) => {
    const next = await tracksPage(ctx, libraryId, cursor);

    if (next.more) {
      await ctx.scheduler.runAfter(0, internal.music.purge.tracks, {
        libraryId,
        cursor: next.cursor,
      });
    } else if (next.gone) {
      await ctx.scheduler.runAfter(0, internal.music.purge.rest, { libraryId });
    }

    return null;
  },
});

/**
 * One page of a removed library's last stage: deletes up to 200 of the albums, then the artists,
 * that its tracks' purge left, which the catalog batch leaves none of unless a defect did, and
 * once none is left, its totals. Answers whether more is left.
 */
export const restPage = async (ctx: MutationCtx, libraryId: Id<"libraries">): Promise<boolean> => {
  const store = musicStore(ctx.db, meterFrom(NO_COST));

  const albums = await store.take(
    "albums",
    (q) => q.withIndex("by_library_added", (index) => index.eq("libraryId", libraryId)),
    ROWS_PAGE,
  );

  if (albums.length > 0) {
    await Promise.all(albums.map(async (album) => store.deleteAlbum(album._id)));

    return true;
  }

  const artists = await store.take(
    "artists",
    (q) => q.withIndex("by_library_key", (index) => index.eq("libraryId", libraryId)),
    ROWS_PAGE,
  );

  if (artists.length > 0) {
    await Promise.all(artists.map(async (artist) => store.deleteArtist(artist._id)));

    return true;
  }

  await forgetTotals(ctx.db, libraryId);

  return false;
};

/** The music purge's last stage for a removed library: `restPage` until nothing is left. */
export const rest = internalMutation({
  args: { libraryId: v.id("libraries") },
  returns: v.null(),
  handler: async (ctx, { libraryId }) => {
    if ((await ctx.db.get(libraryId)) !== null) return null;

    if (await restPage(ctx, libraryId)) {
      await ctx.scheduler.runAfter(0, internal.music.purge.rest, { libraryId });
    }

    return null;
  },
});
