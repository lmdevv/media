import type {
  AccessControl,
  AlbumCard,
  ArtistCard,
  Contributor,
  Device,
  Job,
  Library,
  Playlist,
  PlaylistAccess,
  Role,
  Track,
} from "@music/commands/models";
import { can } from "@music/commands/permissions";
import { signResource } from "@music/commands/signed-url";

import type { Doc, Id } from "../_generated/dataModel";
import { mediaBaseUrl, requireEnv } from "./env";
import type { LibraryCounts } from "./stats";
import { canRead } from "./viewer";
import type { ReadCtx, Viewer } from "./viewer";

type TrackOut = (typeof Track)["Encoded"];

type AlbumOut = (typeof AlbumCard)["Encoded"];

type ArtistOut = (typeof ArtistCard)["Encoded"];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lists of at least this many songs (a queue) look up the viewer's likes in one read when they
 * have at most `LIKES_AT_ONCE`, instead of one index lookup per song.
 */
const LIKES_AT_ONCE_FROM = 100;

/** Most likes read in one go. Every like is an index row the read covers, needed or not. */
const LIKES_AT_ONCE = 200;

/** A device that has not sent a heartbeat for this long is offline. */
export const DEVICE_ONLINE_MS = 75_000;

/**
 * Artwork URLs expire on weekly boundaries so the same cover keeps the same URL for a week and
 * the browser can cache it.
 */
const artExpiry = (now: number): number => Math.ceil(now / WEEK_MS) * WEEK_MS + WEEK_MS;

/** Converts documents into command results for one request, caching signatures and likes. */
export interface Presenter {
  readonly artUrl: (hash: string | undefined) => Promise<string | null>;
  readonly track: (track: Doc<"tracks">) => Promise<TrackOut>;
  readonly tracks: (tracks: ReadonlyArray<Doc<"tracks">>) => Promise<Array<TrackOut>>;
  readonly album: (album: Doc<"albums">) => Promise<AlbumOut>;
  readonly artist: (artist: Doc<"artists">) => Promise<ArtistOut>;
}

/** Builds a presenter bound to the viewer, for adding `liked` and signed artwork. */
export const makePresenter = (ctx: ReadCtx, viewer: Viewer): Presenter => {
  const now = Date.now();
  const expiresAt = artExpiry(now);
  const artCache = new Map<string, Promise<string>>();
  const base = mediaBaseUrl();

  const artUrl = async (hash: string | undefined): Promise<string | null> => {
    if (hash === undefined) return null;
    let pending = artCache.get(hash);

    if (pending === undefined) {
      pending = signResource(requireEnv("STREAM_SIGNING_KEY"), { kind: "art", hash }, expiresAt);
      artCache.set(hash, pending);
    }

    const signature = await pending;

    return `${base}/art/${hash}?exp=${expiresAt}&sig=${signature}`;
  };

  const isLiked = async (trackId: Id<"tracks">): Promise<boolean> => {
    const like = await ctx.db
      .query("likes")
      .withIndex("by_user_track", (q) => q.eq("userId", viewer.id).eq("trackId", trackId))
      .unique();

    return like !== null;
  };

  /** Every song the viewer likes, or null when they like more than `LIKES_AT_ONCE`. */
  const fewLikes = async (): Promise<ReadonlySet<Id<"tracks">> | null> => {
    const likes = await ctx.db
      .query("likes")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .take(LIKES_AT_ONCE + 1);

    return likes.length > LIKES_AT_ONCE ? null : new Set(likes.map((like) => like.trackId));
  };

  /** The cover of the artist's newest readable album that has one, for artists without art. */
  const newestAlbumArt = async (artistId: Id<"artists">): Promise<string | undefined> => {
    const albums = await ctx.db
      .query("albums")
      .withIndex("by_artist", (q) => q.eq("artistId", artistId))
      .collect();

    const [newest] = albums
      .filter(
        (album) =>
          album.artHash !== undefined && album.trackCount > 0 && canRead(viewer, album.libraryId),
      )
      .toSorted(
        (left, right) => (right.year ?? 0) - (left.year ?? 0) || right.addedAt - left.addedAt,
      );

    return newest?.artHash;
  };

  const present = async (doc: Doc<"tracks">, liked: boolean): Promise<TrackOut> => ({
    id: doc._id,
    title: doc.title,
    artist: doc.artistName,
    artistId: doc.artistId,
    album: doc.albumTitle,
    albumId: doc.albumId,
    trackNumber: doc.trackNumber ?? null,
    discNumber: doc.discNumber ?? null,
    durationMs: doc.durationMs,
    codec: doc.codec,
    lossless: doc.lossless,
    bitrate: doc.bitrate ?? null,
    sampleRate: doc.sampleRate ?? null,
    bitDepth: doc.bitDepth ?? null,
    artUrl: await artUrl(doc.artHash),
    liked,
  });

  const track = async (doc: Doc<"tracks">): Promise<TrackOut> =>
    present(doc, await isLiked(doc._id));

  const tracks = async (docs: ReadonlyArray<Doc<"tracks">>): Promise<Array<TrackOut>> => {
    const liked = docs.length >= LIKES_AT_ONCE_FROM ? await fewLikes() : null;

    return Promise.all(
      docs.map((doc) => (liked === null ? track(doc) : present(doc, liked.has(doc._id)))),
    );
  };

  return {
    artUrl,
    track,
    tracks,
    album: async (doc) => ({
      id: doc._id,
      title: doc.title,
      artist: doc.artistName,
      artistId: doc.artistId,
      year: doc.year ?? null,
      artUrl: await artUrl(doc.artHash),
      trackCount: doc.trackCount,
    }),
    artist: async (doc) => ({
      id: doc._id,
      name: doc.name,
      albumCount: doc.albumCount,
      artUrl: await artUrl(doc.artHash ?? (await newestAlbumArt(doc._id))),
    }),
  };
};

/** A device as clients see it. */
export const presentDevice = (doc: Doc<"devices">, now: number): (typeof Device)["Encoded"] => ({
  id: doc.deviceId,
  name: doc.name,
  kind: doc.kind,
  lastSeenAt: doc.lastSeenAt,
  online: now - doc.lastSeenAt < DEVICE_ONLINE_MS,
});

/** A job as clients see it. */
export const presentJob = (
  doc: Doc<"jobs">,
  library: Doc<"libraries"> | null,
): (typeof Job)["Encoded"] => ({
  id: doc._id,
  kind: doc.kind,
  status: doc.status,
  libraryId: doc.libraryId,
  label: `Scan ${library?.name ?? "removed library"}`,
  done: doc.done,
  total: doc.total ?? null,
  message: doc.message ?? null,
  error: doc.error ?? null,
  createdAt: doc._creationTime,
  startedAt: doc.startedAt ?? null,
  finishedAt: doc.finishedAt ?? null,
});

/**
 * How a library's owner is named to `viewerRole`: their name, or, for admins (who see everyone's
 * email in People anyway), their email when they have no name. Members and guests never see
 * someone else's email.
 */
export const ownerLabel = (owner: Doc<"users"> | null, viewerRole: Role): string | null =>
  owner?.name ?? (can(viewerRole, "admin") ? owner?.email : undefined) ?? null;

/** A library folder as clients see it. */
export const presentLibrary = (
  doc: Doc<"libraries">,
  /** Its counters, from `libraryCounts`. */
  counts: LibraryCounts,
  /** How to name the owner: see `ownerLabel`. */
  ownerName: string | null,
  readable: boolean,
  manageable: boolean,
  accessControl: AccessControl,
  scanning: boolean,
): (typeof Library)["Encoded"] => ({
  id: doc._id,
  name: doc.name,
  // A folder path is how a library is found and indexed again, so only its managers see it.
  path: manageable ? doc.path : null,
  manageable,
  accessControl,
  visibility: doc.visibility,
  ownerId: doc.ownerId,
  ownerName,
  readable,
  trackCount: counts.trackCount,
  lastScanAt: doc.lastScanAt ?? null,
  scanning,
});

/** How a person is named on things they share or add. */
export const contributorOf = (user: Doc<"users">): (typeof Contributor)["Encoded"] => ({
  id: user._id,
  name: user.name ?? "Unnamed",
});

/**
 * Looks people up by ID for one request, caching each, for naming who added what. Null for a
 * person whose account is gone.
 */
export const makeContributors = (
  ctx: ReadCtx,
): ((userId: Id<"users">) => Promise<(typeof Contributor)["Encoded"] | null>) => {
  const cache = new Map<Id<"users">, Promise<(typeof Contributor)["Encoded"] | null>>();

  return (userId) => {
    const cached = cache.get(userId);

    if (cached !== undefined) return cached;

    const pending = ctx.db.get(userId).then((user) => (user === null ? null : contributorOf(user)));

    cache.set(userId, pending);

    return pending;
  };
};

/** What the viewer may do with a playlist, and how it is shared, as `presentPlaylist` shows it. */
export interface PlaylistStanding {
  readonly access: PlaylistAccess;
  readonly sharedWithPeople: boolean;
}

/**
 * A playlist summary with up to four covers for its mosaic, taken only from songs the viewer can
 * read: a cover is signed for anyone who holds its URL.
 */
export const presentPlaylist = async (
  ctx: ReadCtx,
  viewer: Viewer,
  presenter: Presenter,
  doc: Doc<"playlists">,
  standing: PlaylistStanding,
): Promise<(typeof Playlist)["Encoded"]> => {
  const items = await ctx.db
    .query("playlistItems")
    .withIndex("by_playlist", (q) => q.eq("playlistId", doc._id))
    .take(24);

  const tracks = await Promise.all(items.map((item) => ctx.db.get(item.trackId)));

  const hashes = [
    ...new Set(
      tracks.flatMap((track) =>
        track === null || track.artHash === undefined || !canRead(viewer, track.libraryId)
          ? []
          : [track.artHash],
      ),
    ),
  ].slice(0, 4);

  const [urls, owner] = await Promise.all([
    Promise.all(hashes.map(presenter.artUrl)),
    ctx.db.get(doc.ownerId),
  ]);

  const artUrls = urls.filter((url): url is string => url !== null);

  return {
    id: doc._id,
    name: doc.name,
    description: doc.description ?? null,
    trackCount: doc.trackCount,
    durationMs: doc.durationMs,
    artUrls,
    updatedAt: doc.updatedAt,
    owner: owner === null ? null : contributorOf(owner),
    visibility: doc.visibility ?? "private",
    sharedWithPeople: standing.sharedWithPeople,
    access: standing.access,
  };
};
