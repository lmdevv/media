/**
 * Who may do what with a playlist, and where its entries sort. The rules themselves live in
 * `@music/commands/permissions` (`canEditPlaylistItems`, `canManagePlaylist`); this module finds
 * the viewer's access from the database.
 *
 * Access comes from ownership, then from a share naming the viewer, then from the playlist's
 * visibility (`shared` lets anyone signed in view it, except guest accounts made from a Jam link,
 * which anyone with that link can create). A playlist the viewer has no access to reads as not
 * found, so a link never tells someone what a private playlist is called.
 */
import type { PlaylistAccess } from "@music/commands/models";
import { can, canEditPlaylistItems, canManagePlaylist } from "@music/commands/permissions";

import type { Doc, Id } from "../_generated/dataModel";
import { fail } from "./errors";
import { tableId } from "./ids";
import { isJamGuest } from "./jams";
import { roleOf } from "./viewer";
import type { ReadCtx, Viewer } from "./viewer";

/** The share naming `userId` on a playlist, if any. */
export const findShare = (
  ctx: ReadCtx,
  playlistId: Id<"playlists">,
  userId: Id<"users">,
): Promise<Doc<"playlistShares"> | null> =>
  ctx.db
    .query("playlistShares")
    .withIndex("by_playlist", (q) => q.eq("playlistId", playlistId).eq("userId", userId))
    .unique();

/** Whether a playlist is shared with anyone by name. */
export const isSharedWithPeople = async (
  ctx: ReadCtx,
  playlistId: Id<"playlists">,
): Promise<boolean> =>
  (await ctx.db
    .query("playlistShares")
    .withIndex("by_playlist", (q) => q.eq("playlistId", playlistId))
    .first()) !== null;

/**
 * Whether a playlist's owner may still have it open to others: they exist (a removed person's
 * playlists go in batches after, unreachable meanwhile), aren't suspended, and may share (a person
 * made a guest keeps their playlists to themselves). Shares and visibility stay, so the playlist
 * opens again on unsuspension or promotion.
 */
export const ownerShares = (owner: Doc<"users"> | null): boolean =>
  owner !== null && owner.suspendedAt === undefined && can(roleOf(owner), "share");

/** What the viewer may do with a playlist, or null when they can't open it. */
export const playlistAccess = async (
  ctx: ReadCtx,
  viewer: Viewer,
  playlist: Doc<"playlists">,
): Promise<PlaylistAccess | null> => {
  if (playlist.ownerId === viewer.id) return "owner";

  if (!ownerShares(await ctx.db.get(playlist.ownerId))) return null;
  const share = await findShare(ctx, playlist._id, viewer.id);

  if (share !== null) return share.role;

  return playlist.visibility === "shared" && !isJamGuest(viewer) ? "viewer" : null;
};

/** What a command needs to do with a playlist. */
export type PlaylistNeed = "view" | "edit" | "manage";

const ALLOWS: Readonly<Record<PlaylistNeed, (access: PlaylistAccess) => boolean>> = {
  view: () => true,
  edit: canEditPlaylistItems,
  manage: canManagePlaylist,
};

const FORBIDDEN: Readonly<Record<Exclude<PlaylistNeed, "view">, string>> = {
  edit: "Only the owner and collaborators can change this playlist's songs",
  manage: "Only the playlist's owner can do that",
};

/** A playlist the viewer opened, with their access to it. */
export interface OpenedPlaylist {
  readonly playlist: Doc<"playlists">;
  readonly access: PlaylistAccess;
}

/**
 * Opens a playlist by wire ID for `need`. Fails `not_found` when the viewer can't open it at all,
 * and `forbidden` when they can open it but not do this.
 */
export const openPlaylist = async (
  ctx: ReadCtx,
  viewer: Viewer,
  id: string,
  need: PlaylistNeed,
): Promise<OpenedPlaylist> => {
  const playlist = await ctx.db.get(tableId(ctx, "playlists", id));
  const access = playlist === null ? null : await playlistAccess(ctx, viewer, playlist);

  if (playlist === null || access === null) return fail("not_found", "Playlist not found");

  if (need !== "view" && !ALLOWS[need](access)) return fail("forbidden", FORBIDDEN[need]);

  return { playlist, access };
};

/** Gap between the sort keys of entries appended one after another. */
export const POSITION_STEP = 1;

/** Below this gap a key between two neighbours loses precision, so the playlist is renumbered. */
const MIN_GAP = 1e-6;

/**
 * The sort key for an entry placed between `before` and `after` (either may be missing at the
 * ends), or null when the two are too close and the entries need renumbering first.
 */
export const positionBetween = (
  before: number | undefined,
  after: number | undefined,
): number | null => {
  if (before === undefined && after === undefined) return POSITION_STEP;

  if (before === undefined) return (after ?? 0) - POSITION_STEP;

  if (after === undefined) return before + POSITION_STEP;

  return after - before < MIN_GAP ? null : (before + after) / 2;
};
