import { v } from "convex/values";

import type { Level } from "../../commands/access";
import { register } from "../../commands/music/playlists";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { printableWithin } from "../core/lib/names";
import { paginateAtMost } from "../core/lib/paginate";
import {
  RESOURCE_GRANTS_MAX,
  deleteGrantsOn,
  grant,
  grantCreator,
  grantOn,
  grantsOn,
  reachOf,
  revoke,
  unshareAll,
} from "../core/permissions/grants";
import type { Reach } from "../core/permissions/grants";
import type { Principal } from "../core/permissions/policy";
import { libraryGates, requirePlaylist } from "./access";
import type { Gates } from "./access";
import { NO_COST, addCost, cost, meterFrom } from "./budget";
import type { Cost } from "./budget";
import { DOCUMENT_BYTES, MUSIC_BOUNDS, TABLE_BYTES } from "./fit";
import { trackFacts } from "./items";
import { ORDER_STEP, orderBetween, renumbered } from "./order";
import { personMeter, readDecided, requireTrackIds, viewDecider } from "./person";
import { contributors, likedAmong, musicPresenter } from "./present";
import type { Contributor, MusicPresenter, Playlist } from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";
import { musicStore } from "./write";
import type { MusicStore, PlaylistChanges } from "./write";

/** Songs a playlist holds at most, as old music's `PLAYLIST_LIMIT`. */
const PLAYLIST_ITEMS_MAX = 2000;

/** Entries whose songs a playlist's mosaic covers come from: its first few. */
const COVER_ITEMS = 8;

/** Covers one mosaic shows. */
const COVERS = 4;

/** Entries one scheduled page of a deleted playlist's purge deletes. */
const PURGE_PAGE = 500;

/**
 * Grants a summary reads to tell how a playlist is shared: the household's own, and the first
 * three by principal, of which one is someone else's whenever anyone else holds one, since only
 * the owner and the household are not.
 */
const SHARING_PEEK = 3;

type PlaylistRef = { readonly type: "playlist"; readonly id: Id<"playlists"> };

const refOf = (playlistId: Id<"playlists">): PlaylistRef => ({ type: "playlist", id: playlistId });

/** What a person may do with a playlist, from the level their grants give them on it. */
const accessOf = (level: Level): Playlist["access"] => {
  if (level === "manage") return "owner";

  return level === "edit" ? "collaborator" : "viewer";
};

const roleOf = (level: Level): "viewer" | "collaborator" =>
  level === "view" ? "viewer" : "collaborator";

const levelOfRole = (role: "viewer" | "collaborator"): Level =>
  role === "viewer" ? "view" : "edit";

/**
 * What presenting one playlist reads: the household's grant and the first three, its owner, its
 * first entries and their songs, and each of those songs' libraries and grants for the caller.
 */
const summaryReads = (reach: Reach): number =>
  2 +
  SHARING_PEEK +
  1 +
  2 * COVER_ITEMS +
  COVER_ITEMS * (1 + reach.direct.length + reach.groups.length);

const SUMMARY_BYTES =
  TABLE_BYTES.playlists +
  (1 + SHARING_PEEK) * DOCUMENT_BYTES.small +
  4 * DOCUMENT_BYTES.small +
  COVER_ITEMS * (DOCUMENT_BYTES.small + TABLE_BYTES.tracks);

/** Decides songs the caller may see, and names people, for one call's summaries. */
interface Summaries {
  readonly db: DatabaseReader;
  readonly gates: Gates;
  readonly present: MusicPresenter;
  readonly named: (userId: Id<"users">) => Promise<Contributor | null>;
}

const summariesFor = (db: DatabaseReader, reach: Reach): Summaries => ({
  db,
  gates: libraryGates(db, reach, "view"),
  present: musicPresenter(),
  named: contributors(db),
});

/**
 * A playlist's summary, as old music's `presentPlaylist` showed it, with up to four covers taken
 * only from songs the caller may see: a cover is signed for anyone who holds its path.
 */
const summarize = async (
  summaries: Summaries,
  playlist: Doc<"playlists">,
  level: Level,
): Promise<Playlist> => {
  const { db } = summaries;
  const ref = refOf(playlist._id);

  const [household, firstGrants, owner, items] = await Promise.all([
    grantOn(db, ref, "household"),
    grantsOn(db, ref, SHARING_PEEK),
    summaries.named(playlist.ownerId),
    db
      .query("playlistItems")
      .withIndex("by_playlist_position", (q) => q.eq("playlistId", playlist._id))
      .take(COVER_ITEMS),
  ]);

  const covers = await Promise.all(
    items.map(async (item) => {
      const track = await db.get(item.trackId);

      return track !== null &&
        track.artHash !== null &&
        (await summaries.gates(track.libraryId))?.admits(trackFacts(track)) === true
        ? [track.artHash]
        : [];
    }),
  );

  const artUrls = await Promise.all(
    [...new Set(covers.flat())].slice(0, COVERS).map(async (hash) => summaries.present.art(hash)),
  );

  return {
    id: playlist._id,
    name: playlist.name,
    description: playlist.description,
    trackCount: playlist.trackCount,
    durationMs: playlist.durationMs,
    artUrls: artUrls.filter((url) => url !== null),
    updatedAt: playlist.updatedAt,
    owner,
    visibility: household === null ? "private" : "shared",
    sharedWithPeople: firstGrants.some(
      (row) => row.principal !== "household" && row.principal !== playlist.ownerId,
    ),
    access: accessOf(level),
  };
};

/** A playlist's name as old music's `Name` took it: printable, 1 to 120 characters. */
const playlistName = (typed: string): string => {
  const name = printableWithin(typed, MUSIC_BOUNDS.playlistName);

  return name !== null && name.length <= MUSIC_BOUNDS.playlistName
    ? name
    : fail(
        "invalid_args",
        `Name the playlist with 1 to ${MUSIC_BOUNDS.playlistName} printable characters`,
      );
};

/**
 * Private-use, unassigned, and surrogate code points, line and paragraph separators, and the
 * bidirectional controls that reorder what others see, as the core's printable names refuse them.
 */
const UNPRINTABLE = /[\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Whether a description others see holds a character no one should see: a control character
 * other than a tab or a line break, or one `UNPRINTABLE` names.
 */
const hasUnprintable = (text: string): boolean =>
  UNPRINTABLE.test(text) ||
  Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code < 0xa0)
    );
  });

/** A description as old music's `Description` took it: trimmed, at most 500; empty for none. */
const playlistDescription = (typed: string): string | null => {
  const description = typed.trim();

  if (description.length > MUSIC_BOUNDS.playlistDescription || hasUnprintable(description)) {
    return fail(
      "invalid_args",
      `Describe the playlist in at most ${MUSIC_BOUNDS.playlistDescription} characters, with no control or direction characters`,
    );
  }

  return description.length === 0 ? null : description;
};

/**
 * What deciding a playlist reads for the caller of `reach`, charged first: the playlist and one
 * grant query per grant key.
 */
const openCost = (reach: Reach): Cost => {
  const keys = reach.direct.length + reach.groups.length;

  return cost(1 + keys, 0, TABLE_BYTES.playlists + keys * DOCUMENT_BYTES.small);
};

/**
 * What sharing or unsharing a playlist costs at most through the core's grants: deciding it again,
 * the person, their grant, and every grant on it, then a write.
 */
const shareCost = (reach: Reach): Cost =>
  addCost(
    openCost(reach),
    cost(3, 1, (2 + RESOURCE_GRANTS_MAX) * DOCUMENT_BYTES.small, DOCUMENT_BYTES.small),
  );

/** Deleting every grant on a playlist: one query of up to 1,000, and a delete of each. */
const DELETE_GRANTS_COST = cost(
  1 + RESOURCE_GRANTS_MAX,
  RESOURCE_GRANTS_MAX,
  2 * RESOURCE_GRANTS_MAX * DOCUMENT_BYTES.small,
);

/** The last entry of a playlist, which songs added go after. */
const lastItem = (store: MusicStore, playlistId: Id<"playlists">) =>
  store.first("playlistItems", (q) =>
    q
      .withIndex("by_playlist_position", (index) => index.eq("playlistId", playlistId))
      .order("desc"),
  );

/**
 * Appends `trackIds` to a playlist the caller may edit, as old music's `appendTracks` did: every
 * song must exist and be one the caller may see, or the call fails `not_found` and adds none; a
 * song whose file went missing goes on, and plays once the file is back. A playlist holds at most
 * 2,000 entries, so more fail with `conflict`.
 */
const appendTracks = async (
  ctx: Pick<MutationCtx, "db">,
  store: MusicStore,
  reach: Reach,
  playlist: Doc<"playlists">,
  trackIds: ReadonlyArray<Id<"tracks">>,
  userId: Id<"users">,
): Promise<ReadonlyArray<Id<"playlistItems">>> => {
  requireTrackIds(trackIds, PLAYLIST_ITEMS_MAX);

  if (playlist.trackCount + trackIds.length > PLAYLIST_ITEMS_MAX) {
    return fail("conflict", `Playlists hold up to ${PLAYLIST_ITEMS_MAX} songs`);
  }

  const writes = cost(
    2,
    trackIds.length + 1,
    DOCUMENT_BYTES.small + TABLE_BYTES.playlists,
    (trackIds.length + 1) * DOCUMENT_BYTES.small + TABLE_BYTES.playlists,
  );

  const decided = await readDecided(
    store,
    viewDecider(ctx.db, reach, store.meter),
    trackIds,
    writes,
  );

  const tracks = decided.flatMap(({ track, allowed }) =>
    track !== null && allowed ? [track] : [],
  );

  if (tracks.length !== trackIds.length) return fail("not_found", "Some songs were not found");

  const last = await lastItem(store, playlist._id);
  const base = last?.position ?? 0;
  const now = Date.now();

  const itemIds = await Promise.all(
    tracks.map(async (track, index) =>
      store.insertPlaylistItem({
        playlistId: playlist._id,
        trackId: track._id,
        position: base + (index + 1) * ORDER_STEP,
        addedBy: userId,
        addedAt: now,
      }),
    ),
  );

  await store.setPlaylist(playlist._id, {
    trackCount: playlist.trackCount + tracks.length,
    durationMs: playlist.durationMs + tracks.reduce((sum, track) => sum + track.durationMs, 0),
    updatedAt: now,
  });

  return itemIds;
};

/** Opens a playlist for `action` in a mutation, charging what deciding it read. */
const openPlaylist = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Principal,
  action: "view" | "edit" | "manage",
  playlistId: Id<"playlists">,
) => {
  const reach = await reachOf(ctx.db, caller);
  const store = musicStore(ctx.db, personMeter(reach));

  store.meter.charge(openCost(reach));

  const { doc: playlist } = await requirePlaylist(ctx.db, caller, action, playlistId);

  return { reach, store, playlist };
};

/** The entry `itemId` of `playlist`, or `not_found` with `missing`. */
const itemOf = async (
  store: MusicStore,
  playlist: Doc<"playlists">,
  itemId: Id<"playlistItems">,
  missing: string,
): Promise<Doc<"playlistItems">> => {
  const item = await store.get("playlistItems", itemId);

  return item === null || item.playlistId !== playlist._id ? fail("not_found", missing) : item;
};

/** Whether `one` comes before `other` in a playlist's order. */
const before = (one: Doc<"playlistItems">, other: Doc<"playlistItems">): boolean =>
  one.position < other.position || (one.position === other.position && one.tie < other.tie);

/**
 * Rewrites every entry's position from the top in the order `ordered` gives, for a move whose
 * neighbours sit too close to split. A playlist holds at most 2,000 entries, a patch each.
 */
const renumber = async (
  store: MusicStore,
  ordered: ReadonlyArray<Doc<"playlistItems">>,
): Promise<void> => {
  await Promise.all(
    ordered.map(async (item, index) =>
      item.position === renumbered(index)
        ? undefined
        : store.setPlaylistItemPosition(item._id, renumbered(index)),
    ),
  );
};

/** The entry after `anchor` in its playlist other than `skip`, or null at the end. */
const nextAfter = async (
  store: MusicStore,
  anchor: Doc<"playlistItems">,
  skip: Id<"playlistItems">,
): Promise<Doc<"playlistItems"> | null> => {
  const found = await store.take(
    "playlistItems",
    (q) =>
      q.withIndex("by_playlist_position", (index) =>
        index.eq("playlistId", anchor.playlistId).gte("position", anchor.position),
      ),
    4,
  );

  return (
    found.find((item) => item._id !== skip && item._id !== anchor._id && before(anchor, item)) ??
    null
  );
};

export const {
  list,
  shared,
  get,
  items,
  create,
  update,
  remove,
  addTracks,
  removeItem,
  moveItem,
  sharing,
  share,
  unshare,
  visibility,
} = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "playlists",
        index: "by_owner_updated",
        range: (q) => q.eq("ownerId", caller.userId),
        order: "desc",
      },
      paginationOpts,
      pageRowsFor(reach, summaryReads(reach), SUMMARY_BYTES),
    );

    const summaries = summariesFor(ctx.db, reach);

    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (playlist) => summarize(summaries, playlist, "manage")),
      ),
    };
  },
  shared: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "grants",
        index: "by_principal_resource",
        range: (q) => q.eq("principal", caller.userId).eq("resourceType", "playlist"),
      },
      paginationOpts,
      pageRowsFor(reach, 1 + summaryReads(reach), DOCUMENT_BYTES.small + SUMMARY_BYTES),
    );

    const summaries = summariesFor(ctx.db, reach);

    const listed = await Promise.all(
      page.page.map(async (row) => {
        const playlistId = ctx.db.normalizeId("playlists", row.resourceId);
        const playlist = playlistId === null ? null : await ctx.db.get(playlistId);

        return playlist === null || row.level === "manage"
          ? []
          : [await summarize(summaries, playlist, row.level)];
      }),
    );

    return { ...page, page: listed.flat() };
  },
  get: async (ctx, { playlistId }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const { doc, level } = await requirePlaylist(ctx.db, caller, "view", playlistId);

    return summarize(summariesFor(ctx.db, reach), doc, level);
  },
  items: async (ctx, { playlistId, paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const { doc: playlist } = await requirePlaylist(ctx.db, caller, "view", playlistId);
    const gates = libraryGates(ctx.db, reach, "view");

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "playlistItems",
        index: "by_playlist_position",
        range: (q) => q.eq("playlistId", playlist._id),
      },
      paginationOpts,
      pageRowsFor(reach, 5, TRACK_ROW_BYTES + 2 * DOCUMENT_BYTES.small),
    );

    const found = await Promise.all(
      page.page.map(async (item) => {
        const track = await ctx.db.get(item.trackId);

        if (track === null) return [];

        const seen = (await gates(track.libraryId))?.admits(trackFacts(track)) === true;

        return [{ item, track, seen }];
      }),
    );

    const entries = found.flat();

    const liked = await likedAmong(
      ctx.db,
      caller.userId,
      entries.flatMap(({ track, seen }) => (seen ? [track._id] : [])),
    );

    const present = musicPresenter();
    const named = contributors(ctx.db);

    return {
      ...page,
      page: await Promise.all(
        entries.map(async ({ item, track, seen }) => {
          const reason = !seen ? "no_access" : track.missing ? "missing" : null;

          return {
            itemId: item._id,
            addedAt: item.addedAt,
            track: seen ? await present.track(track, liked.has(track._id)) : null,
            durationMs: track.durationMs,
            available: reason === null,
            reason,
            addedBy: await named(item.addedBy),
          };
        }),
      ),
    };
  },
  create: async (ctx, args, caller) => {
    const name = playlistName(args.name);

    const description =
      args.description === undefined ? null : playlistDescription(args.description);

    const reach = await reachOf(ctx.db, caller);
    const store = musicStore(ctx.db, personMeter(reach));
    const now = Date.now();

    const playlistId = await store.insertPlaylist({
      ownerId: caller.userId,
      name,
      description,
      trackCount: 0,
      durationMs: 0,
      updatedAt: now,
    });

    store.meter.charge(cost(1, 1, DOCUMENT_BYTES.small, DOCUMENT_BYTES.small));
    await grantCreator(ctx, refOf(playlistId), caller.userId);

    if (args.trackIds !== undefined && args.trackIds.length > 0) {
      const playlist = await store.get("playlists", playlistId);

      if (playlist !== null) {
        await appendTracks(ctx, store, reach, playlist, args.trackIds, caller.userId);
      }
    }

    return { playlistId };
  },
  update: async (ctx, args, caller) => {
    const name = args.name === undefined ? undefined : playlistName(args.name);

    const description =
      args.description === undefined ? undefined : playlistDescription(args.description);

    const { store, playlist } = await openPlaylist(ctx, caller, "manage", args.playlistId);

    const fields: PlaylistChanges = { updatedAt: Date.now() };

    if (name !== undefined) fields.name = name;

    if (description !== undefined) fields.description = description;

    await store.setPlaylist(playlist._id, fields);

    return null;
  },
  remove: async (ctx, { playlistId }, caller) => {
    const { store, playlist } = await openPlaylist(ctx, caller, "manage", playlistId);

    store.meter.charge(DELETE_GRANTS_COST);
    await deleteGrantsOn(ctx, refOf(playlist._id));
    await store.deletePlaylist(playlist._id);
    await ctx.scheduler.runAfter(0, internal.music.playlists.purgeItems, {
      playlistId: playlist._id,
      cursor: null,
    });

    return null;
  },
  addTracks: async (ctx, { playlistId, trackIds }, caller) => {
    const { reach, store, playlist } = await openPlaylist(ctx, caller, "edit", playlistId);

    return {
      itemIds: [...(await appendTracks(ctx, store, reach, playlist, trackIds, caller.userId))],
    };
  },
  removeItem: async (ctx, { playlistId, itemId }, caller) => {
    const { store, playlist } = await openPlaylist(ctx, caller, "edit", playlistId);
    const item = await itemOf(store, playlist, itemId, "That entry is not in this playlist");
    const track = await store.get("tracks", item.trackId);

    await store.deletePlaylistItem(item._id);
    await store.setPlaylist(playlist._id, {
      trackCount: Math.max(0, playlist.trackCount - 1),
      durationMs: Math.max(0, playlist.durationMs - (track?.durationMs ?? 0)),
      updatedAt: Date.now(),
    });

    return null;
  },
  moveItem: async (ctx, { playlistId, itemId, afterItemId }, caller) => {
    if (afterItemId === itemId) return fail("invalid_args", "An entry can't move after itself");

    const { store, playlist } = await openPlaylist(ctx, caller, "edit", playlistId);
    const moving = await itemOf(store, playlist, itemId, "That entry is not in this playlist");

    const after =
      afterItemId === undefined
        ? null
        : await itemOf(
            store,
            playlist,
            afterItemId,
            "The entry to move it after is no longer in this playlist",
          );

    const next =
      after === null
        ? ((
            await store.take(
              "playlistItems",
              (q) =>
                q.withIndex("by_playlist_position", (index) =>
                  index.eq("playlistId", playlist._id),
                ),
              2,
            )
          ).find((item) => item._id !== moving._id) ?? null)
        : await nextAfter(store, after, moving._id);

    const position = orderBetween(after?.position ?? null, next?.position ?? null);

    if (position === null) {
      const all = await store.take(
        "playlistItems",
        (q) => q.withIndex("by_playlist_position", (index) => index.eq("playlistId", playlist._id)),
        PLAYLIST_ITEMS_MAX,
      );

      const rest = all.filter((item) => item._id !== moving._id);
      const at = after === null ? 0 : rest.findIndex((item) => item._id === after._id) + 1;

      await renumber(store, [...rest.slice(0, at), moving, ...rest.slice(at)]);
    } else {
      await store.setPlaylistItemPosition(moving._id, position);
    }

    await store.setPlaylist(playlist._id, { updatedAt: Date.now() });

    return null;
  },
  sharing: async (ctx, { playlistId }, caller) => {
    const { doc: playlist } = await requirePlaylist(ctx.db, caller, "manage", playlistId);
    const rows = await grantsOn(ctx.db, refOf(playlist._id));
    const named = contributors(ctx.db);

    const people = await Promise.all(
      rows.map(async (row) => {
        const userId =
          row.principal === "household" ? null : ctx.db.normalizeId("users", row.principal);

        const person = userId === null || row.level === "manage" ? null : await named(userId);

        return person === null ? [] : [{ person, role: roleOf(row.level) }];
      }),
    );

    return {
      visibility: rows.some((row) => row.principal === "household") ? "shared" : "private",
      people: people.flat(),
    };
  },
  share: async (ctx, { playlistId, userId, role }, caller) => {
    if (userId === caller.userId) return fail("invalid_args", "You already own this playlist");

    const { reach, store, playlist } = await openPlaylist(ctx, caller, "manage", playlistId);
    const ref = refOf(playlist._id);
    const held = await grantOn(ctx.db, ref, userId);
    const level = role === undefined ? (held?.level ?? "view") : levelOfRole(role);

    store.meter.charge(shareCost(reach));
    await grant(ctx, caller, ref, { kind: "user", userId }, level);
    await store.setPlaylist(playlist._id, { updatedAt: Date.now() });

    return null;
  },
  unshare: async (ctx, { playlistId, userId }, caller) => {
    const leaving = userId === caller.userId;

    const { reach, store, playlist } = await openPlaylist(
      ctx,
      caller,
      leaving ? "view" : "manage",
      playlistId,
    );

    const ref = refOf(playlist._id);

    store.meter.charge(shareCost(reach));

    // Leaving needs a share by name, as old music's did: a playlist shared with everyone stays
    // open to whoever has it until its owner makes it private.
    if (leaving && (await grantOn(ctx.db, ref, caller.userId)) === null) {
      return fail("not_found", "This playlist isn't shared with you by name");
    }

    if (userId === undefined) {
      store.meter.charge(DELETE_GRANTS_COST);
      await unshareAll(ctx, caller, ref);
    } else {
      await revoke(ctx, caller, ref, { kind: "user", userId });
    }

    if (!leaving) await store.setPlaylist(playlist._id, { updatedAt: Date.now() });

    return null;
  },
  visibility: async (ctx, { playlistId, visibility: wanted }, caller) => {
    const { reach, store, playlist } = await openPlaylist(ctx, caller, "manage", playlistId);
    const ref = refOf(playlist._id);

    store.meter.charge(shareCost(reach));

    if (wanted === "shared") {
      await grant(ctx, caller, ref, { kind: "household" }, "view");
    } else {
      await revoke(ctx, caller, ref, { kind: "household" });
    }

    await store.setPlaylist(playlist._id, { updatedAt: Date.now() });

    return null;
  },
});

/**
 * Deletes one page of a deleted playlist's entries, and schedules the next. Nothing reads them
 * once their playlist is gone.
 */
export const purgeItems = internalMutation({
  args: { playlistId: v.id("playlists"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { playlistId, cursor }) => {
    const store = musicStore(ctx.db, meterFrom(NO_COST));

    const page = await store.paginate(
      {
        table: "playlistItems",
        index: "by_playlist_position",
        range: (q) => q.eq("playlistId", playlistId),
      },
      { numItems: PURGE_PAGE, cursor },
    );

    await Promise.all(page.page.map(async (item) => store.deletePlaylistItem(item._id)));

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.music.playlists.purgeItems, {
        playlistId,
        cursor: page.continueCursor,
      });
    }

    return null;
  },
});
