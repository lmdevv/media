import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mediaBaseUrl, requireEnv } from "../lib/env";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { makePresenter, presentPlaylist } from "../lib/present";
import { canRead } from "../lib/viewer";
import type { Viewer } from "../lib/viewer";
import { PLAYLIST_LIMIT } from "@music/commands/models";
import { signResource } from "@music/commands/signed-url";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

const STREAM_TTL_MS = 6 * 60 * 60 * 1000;

/** Most likes `likes.list` returns; `likes.page` reads any number. */
const MAX_LIKES = 1000;

const LIKES_PAGE = 50;

const MAX_PLAYLIST = PLAYLIST_LIMIT;

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

const ownPlaylist = async (
  ctx: QueryCtx,
  viewer: Viewer,
  id: string,
): Promise<Doc<"playlists">> => {
  const playlist = await ctx.db.get(tableId(ctx, "playlists", id));

  if (playlist === null || playlist.ownerId !== viewer.id) {
    return fail("not_found", "Playlist not found");
  }

  return playlist;
};

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

  const first = (last?.position ?? 0) + 1;
  const tracks = await Promise.all(ids.map((id) => ctx.db.get(tableId(ctx, "tracks", id))));

  const readable = tracks.filter(
    (track): track is Doc<"tracks"> => track !== null && canRead(viewer, track.libraryId),
  );

  if (readable.length !== ids.length) return fail("not_found", "Some songs were not found");

  await Promise.all(
    readable.map((track, offset) =>
      ctx.db.insert("playlistItems", {
        playlistId: playlist._id,
        trackId: track._id,
        position: first + offset,
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
        : [{ playedAt: play._creationTime, track }];
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
      playlists.map((playlist) => presentPlaylist(ctx, viewer, present, playlist)),
    );
  },

  "playlists.get": async (ctx, viewer, args) => {
    const playlist = await ownPlaylist(ctx, viewer, args.playlistId);
    const present = makePresenter(ctx, viewer);

    const items = await ctx.db
      .query("playlistItems")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
      .take(MAX_PLAYLIST);

    const tracks = await Promise.all(items.map((item) => ctx.db.get(item.trackId)));

    // A song whose file is gone stays as an unavailable entry you can remove. One in a library
    // you can no longer read stays hidden: listing it would show what that library holds.
    const entries = items.flatMap((item, index) => {
      const track = tracks[index];

      return track === undefined || track === null || !canRead(viewer, track.libraryId)
        ? []
        : [{ item, track }];
    });

    return {
      playlist: await presentPlaylist(ctx, viewer, present, playlist),
      items: await Promise.all(
        entries.map(async ({ item, track }) => ({
          itemId: item._id,
          addedAt: item._creationTime,
          track: await present.track(track),
          available: !track.missing,
        })),
      ),
    };
  },

  "stream.url": async (ctx, viewer, args) => {
    const track = await ctx.db.get(tableId(ctx, "tracks", args.trackId));

    if (track === null || track.missing || !canRead(viewer, track.libraryId)) {
      return fail("not_found", "Track not found");
    }

    const expiresAt = Date.now() + STREAM_TTL_MS;

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
      description: args.description,
      trackCount: 0,
      durationMs: 0,
      updatedAt: Date.now(),
    });

    if (args.trackIds !== undefined) {
      const playlist = await ctx.db.get(playlistId);

      if (playlist !== null) await appendTracks(ctx, viewer, playlist, args.trackIds);
    }

    return { playlistId };
  },

  "playlists.rename": async (ctx, viewer, args) => {
    const playlist = await ownPlaylist(ctx, viewer, args.playlistId);
    await ctx.db.patch(playlist._id, { name: args.name, updatedAt: Date.now() });

    return ok;
  },

  "playlists.delete": async (ctx, viewer, args) => {
    const playlist = await ownPlaylist(ctx, viewer, args.playlistId);

    const items = await ctx.db
      .query("playlistItems")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlist._id))
      .collect();

    await Promise.all(items.map((item) => ctx.db.delete(item._id)));
    await ctx.db.delete(playlist._id);

    return ok;
  },

  "playlists.add": async (ctx, viewer, args) => {
    const playlist = await ownPlaylist(ctx, viewer, args.playlistId);
    await appendTracks(ctx, viewer, playlist, args.trackIds);

    return ok;
  },

  "playlists.remove": async (ctx, viewer, args) => {
    const playlist = await ownPlaylist(ctx, viewer, args.playlistId);
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
} satisfies Partial<MutationHandlers>;
