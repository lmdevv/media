import { PLAYLIST_LIMIT } from "@music/commands/models";
import type { LinkKind, PlaylistEntry, ShareLink } from "@music/commands/models";
import { signResource } from "@music/commands/signed-url";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mediaBaseUrl, requireEnv } from "../lib/env";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { jamShareable, resolvePlayback } from "../lib/jams";
import { isClaimed } from "../lib/paths";
import {
  findShare,
  ownerShares,
  isSharedWithPeople,
  openPlaylist,
  positionBetween,
  POSITION_STEP,
} from "../lib/playlists";
import type { OpenedPlaylist } from "../lib/playlists";
import { storedQueue } from "../lib/queue";
import { contributorOf, makeContributors, makePresenter, presentPlaylist } from "../lib/present";
import type { Presenter } from "../lib/present";
import { canRead, loadPerson } from "../lib/viewer";
import type { ReadCtx, Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

/** How long a stream URL works for someone who can read the song's library. */
const STREAM_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a stream URL works for someone who hears the song only through a Jam. A URL can't be
 * taken back once signed, so leaving or being removed from the Jam ends their access this soon;
 * the player signs a new one as it needs to.
 */
const JAM_STREAM_TTL_MS = 5 * 60 * 1000;

/** Most likes `likes.list` returns; `likes.page` reads any number. */
const MAX_LIKES = 1000;

const LIKES_PAGE = 50;

const MAX_PLAYLIST = PLAYLIST_LIMIT;

/** Most shares one playlist lists, and most playlists "Shared with you" lists. */
const MAX_SHARES = 500;

const readableTracks = async (
  ctx: QueryCtx,
  viewer: Viewer,
  ids: ReadonlyArray<Id<"tracks">>,
): Promise<Array<Doc<"tracks">>> => {
  const docs = await Promise.all(ids.map((id) => ctx.db.get(id)));

  return docs.filter(
    (doc): doc is Doc<"tracks"> => doc !== null && !doc.missing && canRead(viewer, doc.libraryId),
  );
};

const playlistEntries = (ctx: ReadCtx, playlistId: Id<"playlists">) =>
  ctx.db
    .query("playlistItems")
    .withIndex("by_playlist", (q) => q.eq("playlistId", playlistId))
    .take(MAX_PLAYLIST);

const appendTracks = async (
  ctx: MutationCtx,
  viewer: Viewer,
  playlist: Doc<"playlists">,
  ids: ReadonlyArray<string>,
): Promise<void> => {
  const last = await ctx.db
    .query("playlistItems")
    .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
    .order("desc")
    .first();

  if (playlist.trackCount + ids.length > MAX_PLAYLIST) {
    return fail("conflict", `Playlists hold up to ${MAX_PLAYLIST} songs`);
  }

  const first = (last?.position ?? 0) + POSITION_STEP;
  const tracks = await Promise.all(ids.map((id) => ctx.db.get(tableId(ctx, "tracks", id))));

  // People add only what they can read themselves, collaborators included.
  const readable = tracks.filter(
    (track): track is Doc<"tracks"> => track !== null && canRead(viewer, track.libraryId),
  );

  if (readable.length !== ids.length) return fail("not_found", "Some songs were not found");

  await Promise.all(
    readable.map((track, offset) =>
      ctx.db.insert("playlistItems", {
        playlistId: playlist._id,
        trackId: track._id,
        position: first + offset * POSITION_STEP,
        addedBy: viewer.id,
      }),
    ),
  );

  const durationMs =
    playlist.durationMs + readable.reduce((total, track) => total + track.durationMs, 0);

  await ctx.db.patch(playlist._id, {
    trackCount: playlist.trackCount + ids.length,
    durationMs,
    updatedAt: Date.now(),
  });
};

/**
 * Changes a playlist's name or description (owner only). `undefined` in a patch removes a field,
 * so only the fields asked for go in; an empty description, already cleaned and trimmed by its
 * schema, removes it.
 */
const updatePlaylist = async (
  ctx: MutationCtx,
  viewer: Viewer,
  args: { readonly playlistId: string; readonly name?: string; readonly description?: string },
): Promise<typeof ok> => {
  const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "manage");
  const changes: Partial<Doc<"playlists">> = { updatedAt: Date.now() };

  if (args.name !== undefined) changes.name = args.name;

  if (args.description !== undefined) {
    changes.description = args.description.length === 0 ? undefined : args.description;
  }

  await ctx.db.patch(playlist._id, changes);

  return ok;
};

/** A playlist summary for someone who opened it with `opened.access`. */
const summary = async (ctx: ReadCtx, viewer: Viewer, present: Presenter, opened: OpenedPlaylist) =>
  presentPlaylist(ctx, viewer, present, opened.playlist, {
    access: opened.access,
    sharedWithPeople: await isSharedWithPeople(ctx, opened.playlist._id),
  });

/**
 * One playlist entry as the viewer sees it. A song in a library they can't read still shows, so
 * everyone sees the same playlist, but greyed out and without its cover or file details.
 */
const presentEntry = async (
  viewer: Viewer,
  present: Presenter,
  contributor: ReturnType<typeof makeContributors>,
  playlist: Doc<"playlists">,
  item: Doc<"playlistItems">,
  track: Doc<"tracks">,
): Promise<(typeof PlaylistEntry)["Encoded"]> => {
  const readable = canRead(viewer, track.libraryId);
  const reason = !readable ? "no_access" : track.missing ? "missing" : null;

  return {
    itemId: item._id,
    addedAt: item._creationTime,
    // A song in a library the viewer can't read is withheld whole: no name, cover, file detail,
    // or ID, so neither sharing a playlist nor a library's access narrowing later shows what the
    // library holds. The entry keeps its place and length.
    track: readable ? await present.track(track) : null,
    durationMs: track.durationMs,
    available: reason === null,
    reason,
    addedBy: await contributor(item.addedBy ?? playlist.ownerId),
  };
};

/** Deletes a playlist with its entries and shares. */
const deletePlaylist = async (ctx: MutationCtx, playlist: Doc<"playlists">): Promise<void> => {
  // Adding stops at these limits, so they bound what a playlist holds.
  const [items, shares] = await Promise.all([
    ctx.db
      .query("playlistItems")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
      .take(MAX_PLAYLIST),
    ctx.db
      .query("playlistShares")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
      .take(MAX_SHARES),
  ]);

  await Promise.all([...items, ...shares].map((doc) => ctx.db.delete(doc._id)));
  await ctx.db.delete(playlist._id);
};

const unavailableLink = () => fail("not_found", "That isn't available to you");

/**
 * Builds a link to something the viewer can open. Albums, artists, and songs need a library they
 * can read; a playlist needs access to it. A song opens its album, highlighted.
 */
type LinkBuilders = {
  readonly [Kind in LinkKind]: (
    ctx: QueryCtx,
    viewer: Viewer,
    id: string,
  ) => Promise<(typeof ShareLink)["Encoded"]>;
};

const LINKS = {
  album: async (ctx, viewer, id) => {
    const album = await ctx.db.get(tableId(ctx, "albums", id));

    if (album === null || !canRead(viewer, album.libraryId)) return unavailableLink();

    return { path: `/albums/${album._id}`, title: album.title };
  },
  artist: async (ctx, viewer, id) => {
    const artist = await ctx.db.get(tableId(ctx, "artists", id));

    if (artist === null || !canRead(viewer, artist.libraryId)) return unavailableLink();

    return { path: `/artists/${artist._id}`, title: artist.name };
  },
  playlist: async (ctx, viewer, id) => {
    const { playlist } = await openPlaylist(ctx, viewer, id, "view");

    return { path: `/playlists/${playlist._id}`, title: playlist.name };
  },
  track: async (ctx, viewer, id) => {
    const track = await ctx.db.get(tableId(ctx, "tracks", id));

    if (track === null || !canRead(viewer, track.libraryId)) return unavailableLink();

    return { path: `/albums/${track.albumId}?track=${track._id}`, title: track.title };
  },
} satisfies LinkBuilders;

/**
 * Whether `trackId` is in the queue of the Jam the viewer has joined. People in a Jam may stream
 * the songs the host plays even from libraries they can't read, but only those, and only while
 * they are in it. The host must still be able to read the song.
 */
const inJamQueue = async (
  ctx: QueryCtx,
  viewer: Viewer,
  trackId: Id<"tracks">,
): Promise<boolean> => {
  const playback = await resolvePlayback(ctx, viewer);

  if (playback.kind !== "member") return false;

  const [queue, track] = await Promise.all([
    storedQueue(ctx, playback.owner.id),
    ctx.db.get(trackId),
  ]);

  const entries = queue.items.filter((item) => item.trackId === trackId);

  if (track === null || !canRead(playback.owner, track.libraryId) || entries.length === 0) {
    return false;
  }

  // Someone in the Jam chose it (the host, or a person who can read it): it plays for all.
  if (entries.some((item) => !item.autoplay)) return true;

  // Autoplay chose it: only from a library the Jam may share, for entries from before that rule.
  const library = await ctx.db.get(track.libraryId);

  return library !== null && jamShareable(library, playback.owner.id);
};

const touch = (ctx: MutationCtx, playlist: Doc<"playlists">) =>
  ctx.db.patch(playlist._id, { updatedAt: Date.now() });

export const collectionQueries = {
  "likes.list": async (ctx, viewer) => {
    const likes = await ctx.db
      .query("likes")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .order("desc")
      .take(MAX_LIKES);

    const tracks = await readableTracks(
      ctx,
      viewer,
      likes.map((like) => like.trackId),
    );

    return makePresenter(ctx, viewer).tracks(tracks);
  },

  "likes.page": async (ctx, viewer, args) => {
    const page = await ctx.db
      .query("likes")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        endCursor: args.end ?? null,
        numItems: args.limit ?? LIKES_PAGE,
      });

    // A song you can no longer read, or whose file is gone, is left out, so a page can come back
    // short while `done` is false.
    const tracks = await readableTracks(
      ctx,
      viewer,
      page.page.map((like) => like.trackId),
    );

    return {
      items: await makePresenter(ctx, viewer).tracks(tracks),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },

  "history.list": async (ctx, viewer, args) => {
    const plays = await ctx.db
      .query("history")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .order("desc")
      .take(args.limit ?? 50);

    const present = makePresenter(ctx, viewer);
    const tracks = await Promise.all(plays.map((play) => ctx.db.get(play.trackId)));

    const entries = plays.flatMap((play, index) => {
      const track = tracks[index];

      return track === undefined || track === null || !canRead(viewer, track.libraryId)
        ? []
        : [{ playedAt: play.playedAt ?? play._creationTime, track }];
    });

    return Promise.all(
      entries.map(async (entry) => ({
        playedAt: entry.playedAt,
        track: await present.track(entry.track),
      })),
    );
  },

  "playlists.list": async (ctx, viewer) => {
    const playlists = await ctx.db
      .query("playlists")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer.id))
      .order("desc")
      .collect();

    const present = makePresenter(ctx, viewer);

    return Promise.all(
      playlists.map((playlist) => summary(ctx, viewer, present, { playlist, access: "owner" })),
    );
  },

  "playlists.shared": async (ctx, viewer) => {
    const shares = await ctx.db
      .query("playlistShares")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .take(MAX_SHARES);

    const present = makePresenter(ctx, viewer);
    const playlists = await Promise.all(shares.map((share) => ctx.db.get(share.playlistId)));

    const owners = await Promise.all(
      playlists.map(async (playlist) => (playlist === null ? null : ctx.db.get(playlist.ownerId))),
    );

    const opened = shares.flatMap((share, index) => {
      const playlist = playlists[index];
      const owner = owners[index];

      // A removed owner's playlists go with them; a guest's are theirs alone (`playlistAccess`).
      return playlist === undefined || playlist === null || !ownerShares(owner ?? null)
        ? []
        : [{ playlist, access: share.role }];
    });

    // Each of these is shared with the viewer, so none needs looking up.
    const listed = await Promise.all(
      opened.map((open) =>
        presentPlaylist(ctx, viewer, present, open.playlist, {
          access: open.access,
          sharedWithPeople: true,
        }),
      ),
    );

    return listed.toSorted((left, right) => right.updatedAt - left.updatedAt);
  },

  "playlists.get": async (ctx, viewer, args) => {
    const opened = await openPlaylist(ctx, viewer, args.playlistId, "view");
    const { playlist } = opened;
    const present = makePresenter(ctx, viewer);
    const contributor = makeContributors(ctx);
    const items = await playlistEntries(ctx, playlist._id);
    const tracks = await Promise.all(items.map((item) => ctx.db.get(item.trackId)));

    const entries = items.flatMap((item, index) => {
      const track = tracks[index];

      return track === undefined || track === null ? [] : [{ item, track }];
    });

    return {
      playlist: await summary(ctx, viewer, present, opened),
      items: await Promise.all(
        entries.map(({ item, track }) =>
          presentEntry(viewer, present, contributor, playlist, item, track),
        ),
      ),
    };
  },

  "playlists.sharing": async (ctx, viewer, args) => {
    const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "manage");

    const shares = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
      .take(MAX_SHARES);

    const people = await Promise.all(shares.map((share) => ctx.db.get(share.userId)));

    return {
      visibility: playlist.visibility ?? "private",
      people: shares.flatMap((share, index) => {
        const person = people[index];

        return person === undefined || person === null
          ? []
          : [{ person: contributorOf(person), role: share.role }];
      }),
    };
  },

  "links.get": (ctx, viewer, args) => LINKS[args.kind](ctx, viewer, args.id),

  "stream.url": async (ctx, viewer, args) => {
    const track = await ctx.db.get(tableId(ctx, "tracks", args.trackId));

    if (track === null || track.missing) return fail("not_found", "Track not found");

    const readable = canRead(viewer, track.libraryId);

    if (!readable && !(await inJamQueue(ctx, viewer, track._id))) {
      return fail("not_found", "Track not found");
    }

    // No token for a library whose folder no scan has claimed, or whose claim was refused: the
    // media service would refuse it anyway (`media:trackSource`), so fail here, plainly.
    if (!isClaimed(await ctx.db.get(track.libraryId))) {
      return fail("not_found", "Track not found");
    }

    const expiresAt = Date.now() + (readable ? STREAM_TTL_MS : JAM_STREAM_TTL_MS);

    const signature = await signResource(
      requireEnv("STREAM_SIGNING_KEY"),
      { kind: "stream", trackId: track._id, profile: args.profile },
      expiresAt,
    );

    return {
      trackId: track._id,
      profile: args.profile,
      expiresAt,
      url: `${mediaBaseUrl()}/stream/${track._id}?p=${args.profile}&exp=${expiresAt}&sig=${signature}`,
    };
  },
} satisfies Partial<QueryHandlers>;

export const collectionMutations = {
  "likes.set": async (ctx, viewer, args) => {
    const trackId = tableId(ctx, "tracks", args.trackId);
    const track = await ctx.db.get(trackId);

    if (track === null || !canRead(viewer, track.libraryId)) {
      return fail("not_found", "Track not found");
    }

    const existing = await ctx.db
      .query("likes")
      .withIndex("by_user_track", (q) => q.eq("userId", viewer.id).eq("trackId", trackId))
      .unique();

    if (args.liked && existing === null) {
      await ctx.db.insert("likes", { userId: viewer.id, trackId });
    }

    if (!args.liked && existing !== null) await ctx.db.delete(existing._id);

    return ok;
  },

  "playlists.create": async (ctx, viewer, args) => {
    const playlistId = await ctx.db.insert("playlists", {
      ownerId: viewer.id,
      name: args.name,
      // Cleaned and trimmed by its schema; empty means none, as `playlists.update` treats it.
      description:
        args.description === undefined || args.description.length === 0
          ? undefined
          : args.description,
      trackCount: 0,
      durationMs: 0,
      updatedAt: Date.now(),
      visibility: "private",
    });

    if (args.trackIds !== undefined) {
      const playlist = await ctx.db.get(playlistId);

      if (playlist !== null) await appendTracks(ctx, viewer, playlist, args.trackIds);
    }

    return { playlistId };
  },

  // Kept for clients from before `playlists.update`; it is that command with only a name.
  "playlists.rename": async (ctx, viewer, args) => updatePlaylist(ctx, viewer, args),

  "playlists.update": updatePlaylist,

  "playlists.delete": async (ctx, viewer, args) => {
    const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "manage");
    await deletePlaylist(ctx, playlist);

    return ok;
  },

  "playlists.add": async (ctx, viewer, args) => {
    const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "edit");
    await appendTracks(ctx, viewer, playlist, args.trackIds);

    return ok;
  },

  "playlists.remove": async (ctx, viewer, args) => {
    const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "edit");
    const item = await ctx.db.get(tableId(ctx, "playlistItems", args.itemId));

    if (item === null || item.playlistId !== playlist._id) {
      return fail("not_found", "That entry is not in this playlist");
    }

    const track = await ctx.db.get(item.trackId);
    await ctx.db.delete(item._id);
    await ctx.db.patch(playlist._id, {
      trackCount: Math.max(0, playlist.trackCount - 1),
      durationMs: Math.max(0, playlist.durationMs - (track?.durationMs ?? 0)),
      updatedAt: Date.now(),
    });

    return ok;
  },

  "playlists.move": async (ctx, viewer, args) => {
    const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "edit");

    if (args.afterItemId === args.itemId) {
      return fail("invalid_args", "An entry can't move after itself");
    }

    const itemId = tableId(ctx, "playlistItems", args.itemId);

    const afterId =
      args.afterItemId === undefined ? null : tableId(ctx, "playlistItems", args.afterItemId);

    const items = await playlistEntries(ctx, playlist._id);
    const moving = items.find((item) => item._id === itemId);

    if (moving === undefined) return fail("not_found", "That entry is not in this playlist");

    const rest = items.filter((item) => item._id !== moving._id);
    const after = afterId === null ? -1 : rest.findIndex((item) => item._id === afterId);

    // The entry it should follow was removed meanwhile; moving anyway would guess the place.
    if (after === -1 && args.afterItemId !== undefined) {
      return fail("not_found", "The entry to move it after is no longer in this playlist");
    }

    const position = positionBetween(rest[after]?.position, rest[after + 1]?.position);

    if (position !== null) {
      await ctx.db.patch(moving._id, { position });
    } else {
      // Moved between the same two entries many times over: renumber the whole playlist.
      const order = [...rest.slice(0, after + 1), moving, ...rest.slice(after + 1)];

      await Promise.all(
        order.map((item, index) =>
          ctx.db.patch(item._id, { position: (index + 1) * POSITION_STEP }),
        ),
      );
    }

    await touch(ctx, playlist);

    return ok;
  },

  "playlists.visibility": async (ctx, viewer, args) => {
    const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "manage");
    await ctx.db.patch(playlist._id, { visibility: args.visibility, updatedAt: Date.now() });

    return ok;
  },

  "playlists.share": async (ctx, viewer, args) => {
    const { playlist } = await openPlaylist(ctx, viewer, args.playlistId, "manage");
    const person = await loadPerson(ctx, args.userId);

    if (person._id === viewer.id) return fail("invalid_args", "You already own this playlist");

    // The directory leaves suspended people out; a share made by ID can't reach them either.
    if (person.suspendedAt !== undefined) return fail("not_found", "Person not found");

    const existing = await findShare(ctx, playlist._id, person._id);
    // Sharing again without a role keeps theirs, so it never quietly takes edit rights away.
    const role = args.role ?? existing?.role ?? "viewer";

    if (existing === null) {
      // Lists of shares stop at this many, so a share past it could never be seen or left.
      const [onPlaylist, toPerson] = await Promise.all([
        ctx.db
          .query("playlistShares")
          .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
          .take(MAX_SHARES),
        ctx.db
          .query("playlistShares")
          .withIndex("by_user", (q) => q.eq("userId", person._id))
          .take(MAX_SHARES),
      ]);

      if (onPlaylist.length >= MAX_SHARES) {
        return fail("conflict", `A playlist can be shared with up to ${MAX_SHARES} people`);
      }

      if (toPerson.length >= MAX_SHARES) {
        return fail("conflict", `They already have ${MAX_SHARES} playlists shared with them`);
      }

      await ctx.db.insert("playlistShares", {
        playlistId: playlist._id,
        userId: person._id,
        role,
        sharedBy: viewer.id,
      });
    } else if (existing.role !== role) {
      await ctx.db.patch(existing._id, { role });
    }

    await touch(ctx, playlist);

    return ok;
  },

  "playlists.unshare": async (ctx, viewer, args) => {
    const { playlist, access } = await openPlaylist(ctx, viewer, args.playlistId, "view");
    const userId = args.userId === undefined ? null : tableId(ctx, "users", args.userId);

    // Anyone a playlist is shared with can leave it.
    if (userId === viewer.id && access !== "owner") {
      const share = await findShare(ctx, playlist._id, viewer.id);

      // Opened by its link only: there is no share to leave, and access stays.
      if (share === null) return fail("not_found", "This playlist isn't shared with you by name");
      await ctx.db.delete(share._id);

      return ok;
    }

    if (access !== "owner") return fail("forbidden", "Only the playlist's owner can do that");

    if (userId !== null) {
      const share = await findShare(ctx, playlist._id, userId);

      if (share === null) return fail("not_found", "This playlist isn't shared with them");
      await ctx.db.delete(share._id);
      await touch(ctx, playlist);

      return ok;
    }

    // Stop sharing at all: nobody but the owner can open it from now on. Sharing stops at
    // `MAX_SHARES`, so this takes them all.
    const shares = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
      .take(MAX_SHARES);

    await Promise.all(shares.map((share) => ctx.db.delete(share._id)));
    await ctx.db.patch(playlist._id, { visibility: "private", updatedAt: Date.now() });

    return ok;
  },
} satisfies Partial<MutationHandlers>;
