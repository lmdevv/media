import {
  MAX_KEPT_PARTS,
  creditParts,
  isCombined,
  staysWhole,
} from "@media/contracts/artist-credits";
import { v } from "convex/values";

import { register } from "../../commands/music/credits";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { inOrder } from "../core/lib/inOrder";
import { paginateAtMost } from "../core/lib/paginate";
import { requireContent } from "../core/permissions/grants";
import type { Caller } from "../core/auth/caller";
import { CALL_COST, cost, meterFrom, repeated, sumCost } from "./budget";
import { RECREDIT_COST, catalogBatch } from "./catalog";
import type { CatalogBatch, Rechecks } from "./catalog";
import { MAX_OVERRIDES, RESOLVING, creditLedger } from "./creditLedger";
import { MUSIC_BOUNDS, keyOf } from "./fit";
import { LIST_PAGE_MAX } from "./reads";
import { atBound, musicStore } from "./write";
import type { MusicStore } from "./write";

/**
 * Artist credits after the evidence changes (ADR 0024, "Artist credits"). A combined credit
 * string resolves from what the library knows of its parts, so when a name gains its first whole
 * credit or loses its last, or a manager corrects a credit, every combined string that name is
 * part of is rechecked (`recheck`), and each that resolves anew rewrites the credits of every song
 * and album it names (`rewrite`). Both are chains of internal mutations, a page each, as the purge
 * is (ADR 0013): the work is the core's own, and no server worker has anything to do with it.
 */

/** What one recheck or rewrite call spends before its first item: the library, and its counters. */
const FIXED_COST = cost(30, 12, 64 * 1024, 4 * 1024);

/** A recheck's own work: `FIXED_COST` and the library's corrections, read at their bound. */
const RECHECK_FIXED = sumCost([FIXED_COST, atBound.read("creditOverrides", MAX_OVERRIDES)]);

/**
 * Rechecking one combined string: its part's row read, the string resolved fresh, its resolution
 * written, and a rewrite and a further recheck scheduled.
 */
const RECHECK_ONE = sumCost([
  atBound.read("creditParts"),
  RESOLVING,
  atBound.patch("artistCredits"),
  repeated(cost(0, 1, 0, 2 * 1024), 2),
]);

/**
 * Combined strings one recheck call takes: as many as the call can resolve with every row at its
 * bound, so a page never stops partway and is never read again.
 */
export const RECHECK_PAGE = Math.max(
  1,
  Math.min(
    Math.floor((CALL_COST.readBytes - RECHECK_FIXED.readBytes) / RECHECK_ONE.readBytes),
    Math.floor((CALL_COST.work.ranges - RECHECK_FIXED.work.ranges) / RECHECK_ONE.work.ranges),
  ),
);

/** Songs or albums one rewrite call reads, as many as its budget then rewrites. */
const REWRITE_PAGE = 200;

/** Schedules a recheck of the combined strings each named part of `libraryId` is in. */
export const rechecksFor =
  (ctx: Pick<MutationCtx, "scheduler">, libraryId: Id<"libraries">): Rechecks =>
  async (partKeys) => {
    if (partKeys.length === 0) return;

    await ctx.scheduler.runAfter(0, internal.music.credits.recheck, {
      libraryId,
      partKeys: [...partKeys],
      cursor: null,
    });
  };

/** Whether two resolutions name the same artists in the same order and spelling. */
const sameNames = (one: ReadonlyArray<string>, other: ReadonlyArray<string>): boolean =>
  one.length === other.length && one.every((name, index) => name === other[index]);

/** The library a chain works in, or null once it is gone or is not a music library. */
const musicLibrary = async (
  ctx: Pick<QueryCtx, "db">,
  libraryId: Id<"libraries">,
): Promise<Doc<"libraries"> | null> => {
  const library = await ctx.db.get(libraryId);

  return library?.kind === "music" ? library : null;
};

/**
 * Rechecks a page of the combined credit strings that the first of `partKeys` is part of in a
 * library, from `cursor`, then the next page or the next key. Each string resolves fresh from the
 * library's evidence; one that resolves anew stores its new resolution and schedules a `rewrite`
 * of what it names, and one that started or stopped staying whole schedules a recheck of the
 * longer credits it may be a run of.
 */
export const recheck = internalMutation({
  args: {
    libraryId: v.id("libraries"),
    partKeys: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { libraryId, partKeys, cursor }) => {
    const [partKey, ...rest] = partKeys;

    if (partKey === undefined || (await musicLibrary(ctx, libraryId)) === null) return null;

    const store = musicStore(ctx.db, meterFrom(RECHECK_FIXED));
    // A recheck settles no uses, so it owes the ledger nothing.
    const ledger = creditLedger(store, libraryId, () => undefined);

    await ledger.prepare();

    const page = await store.paginate(
      {
        table: "creditParts",
        index: "by_library_part",
        range: (q) => q.eq("libraryId", libraryId).eq("partKey", partKey),
      },
      { numItems: RECHECK_PAGE, cursor },
    );

    const longer = await inOrder(page.page, async (part) => {
      const row = await ledger.row(part.creditKey);

      if (row === null) return null;

      const next = await ledger.resolveFresh(row.text);

      if (sameNames(next, row.artists)) return null;

      await store.setCreditArtists(row._id, next);
      await ctx.scheduler.runAfter(0, internal.music.credits.rewrite, {
        libraryId,
        creditKey: row.key,
        phase: "tracks",
        cursor: null,
      });

      const parts = creditParts(row.text);
      const [first] = parts;

      return first !== undefined &&
        parts.length <= MAX_KEPT_PARTS &&
        staysWhole(row.text, row.artists) !== staysWhole(row.text, next)
        ? keyOf(first.name)
        : null;
    });

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.music.credits.recheck, {
        libraryId,
        partKeys,
        cursor: page.continueCursor,
      });
    } else if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, internal.music.credits.recheck, {
        libraryId,
        partKeys: rest,
        cursor: null,
      });
    }

    await rechecksFor(ctx, libraryId)([...new Set(longer.filter((key) => key !== null))]);

    return null;
  },
});

/** How far one page of a rewrite got: the rows it read, those it rewrote, and where it ends. */
interface RewriteStep {
  readonly read: number;
  readonly done: number;
  readonly continueCursor: string;
  readonly isDone: boolean;
}

/** Rewrites a page of the songs whose tags name the combined credit `creditKey`. */
const rewriteTracks = async (
  store: MusicStore,
  batch: CatalogBatch,
  libraryId: Id<"libraries">,
  creditKey: string,
  cursor: string | null,
): Promise<RewriteStep> => {
  const found = await store.paginate(
    {
      table: "creditTracks",
      index: "by_library_credit",
      range: (q) => q.eq("libraryId", libraryId).eq("creditKey", creditKey),
    },
    { numItems: REWRITE_PAGE, cursor },
  );

  const done = await batch.each(found.page, (row) => batch.recredit(row.trackId), RECREDIT_COST);

  return { ...found, read: found.page.length, done: done.length };
};

/** Rewrites a page of the albums filed under the combined credit `creditKey`. */
const rewriteAlbums = async (
  store: MusicStore,
  batch: CatalogBatch,
  libraryId: Id<"libraries">,
  creditKey: string,
  cursor: string | null,
): Promise<RewriteStep> => {
  const found = await store.paginate(
    {
      table: "albums",
      index: "by_library_filing",
      range: (q) =>
        q.eq("libraryId", libraryId).eq("artistKey", creditKey).eq("creditsTagged", false),
    },
    { numItems: REWRITE_PAGE, cursor },
  );

  const done = await batch.each(
    found.page,
    (album) => batch.recreditAlbum(album._id),
    RECREDIT_COST,
  );

  return { ...found, read: found.page.length, done: done.length };
};

/**
 * Rewrites the credits of a page of the songs, then of the albums, that name the combined credit
 * string `creditKey` in a library, from `cursor`, as many as the call's budget admits, through the
 * catalog batch, which settles the artists' counts and deletes an artist left credited by nothing.
 * A page the budget stopped is read again; the songs it rewrote already match.
 */
export const rewrite = internalMutation({
  args: {
    libraryId: v.id("libraries"),
    creditKey: v.string(),
    phase: v.union(v.literal("tracks"), v.literal("albums")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { libraryId, creditKey, phase, cursor }) => {
    if ((await musicLibrary(ctx, libraryId)) === null) return null;

    const store = musicStore(ctx.db, meterFrom(FIXED_COST));
    const batch = catalogBatch(store, libraryId, rechecksFor(ctx, libraryId));
    const rewritePage = phase === "tracks" ? rewriteTracks : rewriteAlbums;
    const step = await rewritePage(store, batch, libraryId, creditKey, cursor);

    await batch.finish();

    const following =
      step.done < step.read
        ? { phase, cursor }
        : !step.isDone
          ? { phase, cursor: step.continueCursor }
          : phase === "tracks"
            ? { phase: "albums" as const, cursor: null }
            : null;

    if (following !== null) {
      await ctx.scheduler.runAfter(0, internal.music.credits.rewrite, {
        libraryId,
        creditKey,
        ...following,
      });
    }

    return null;
  },
});

/** The music library `libraryId`, which the caller must manage. */
const managedLibrary = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Caller,
  libraryId: Id<"libraries">,
): Promise<Doc<"libraries">> => {
  const { doc } = await requireContent(ctx, caller, "manage", { type: "library", id: libraryId });

  return doc.kind === "music" ? doc : fail("not_found", "No such library");
};

/**
 * A credit string a manager typed, trimmed: one with separators to split on, within a name's
 * maximum.
 */
const parseCredit = (typed: string): string => {
  const name = typed.trim();

  if (name.length === 0 || name.length > MUSIC_BOUNDS.name) {
    return fail("invalid_args", `Name a credit with 1 to ${MUSIC_BOUNDS.name} characters`);
  }

  if (!isCombined(name)) {
    return fail(
      "invalid_args",
      `"${name}" names one artist: there is nothing to split or keep together (separators are ", ", " & ", " feat. ", " ft. ", and " featuring ")`,
    );
  }

  return name;
};

/** Whom a correction of `name` may change: every combined credit its first part is part of. */
const firstPartKey = (name: string): string => keyOf(creditParts(name)[0]?.name ?? name);

/** Credit rows one page of `list` reads at most: each with the correction of its name. */
const CREDITS_PAGE = LIST_PAGE_MAX;

export const { list, overrides, setOverride, removeOverride } = register({
  list: async (ctx, { libraryId, paginationOpts }, caller) => {
    await managedLibrary(ctx, caller, libraryId);

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "artistCredits",
        index: "by_library_combined",
        range: (q) => q.eq("libraryId", libraryId).eq("combined", true),
      },
      paginationOpts,
      CREDITS_PAGE,
    );

    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (row) => {
          const corrected = await ctx.db
            .query("creditOverrides")
            .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId).eq("key", row.key))
            .first();

          return {
            name: row.text,
            artists: row.artists,
            override: corrected?.mode ?? null,
            uses: row.uses,
          };
        }),
      ),
    };
  },
  overrides: async (ctx, { libraryId, paginationOpts }, caller) => {
    await managedLibrary(ctx, caller, libraryId);

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "creditOverrides",
        index: "by_library_key",
        range: (q) => q.eq("libraryId", libraryId),
      },
      paginationOpts,
      MAX_OVERRIDES,
    );

    return { ...page, page: page.page.map((row) => ({ name: row.text, mode: row.mode })) };
  },
  setOverride: async (ctx, { libraryId, name: typed, mode }, caller) => {
    await managedLibrary(ctx, caller, libraryId);

    const name = parseCredit(typed);
    const key = keyOf(name);
    const store = musicStore(ctx.db, meterFrom(FIXED_COST));

    const all = await store.take(
      "creditOverrides",
      (q) => q.withIndex("by_library_key", (index) => index.eq("libraryId", libraryId)),
      MAX_OVERRIDES,
    );

    const existing = all.find((row) => row.key === key) ?? null;

    if (existing?.mode === mode && existing.text === name) return null;

    if (existing === null && all.length >= MAX_OVERRIDES) {
      return fail(
        "invalid_args",
        `A library keeps at most ${MAX_OVERRIDES} credit corrections; remove one first`,
      );
    }

    await store.setCreditOverride(existing?._id ?? null, { libraryId, key, text: name, mode });

    if (existing?.mode !== mode) await rechecksFor(ctx, libraryId)([firstPartKey(name)]);

    return null;
  },
  removeOverride: async (ctx, { libraryId, name: typed }, caller) => {
    await managedLibrary(ctx, caller, libraryId);

    const name = typed.trim();
    const store = musicStore(ctx.db, meterFrom(FIXED_COST));

    const existing = await store.first("creditOverrides", (q) =>
      q.withIndex("by_library_key", (index) =>
        index.eq("libraryId", libraryId).eq("key", keyOf(name)),
      ),
    );

    if (existing === null) return null;

    await store.deleteCreditOverride(existing._id);
    await rechecksFor(ctx, libraryId)([firstPartKey(existing.text)]);

    return null;
  },
});
