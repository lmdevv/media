import type {
  AlbumCard,
  ArtistCard,
  Device,
  Job,
  Library,
  Playlist,
  Track,
} from "@music/commands/models";
import { signResource } from "@music/commands/signed-url";

import type { Doc, Id } from "../_generated/dataModel";
import { mediaBaseUrl, requireEnv } from "./env";
import type { ReadCtx, Viewer } from "./viewer";

type TrackOut = (typeof Track)["Encoded"];

type AlbumOut = (typeof AlbumCard)["Encoded"];

type ArtistOut = (typeof ArtistCard)["Encoded"];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

  const track = async (doc: Doc<"tracks">): Promise<TrackOut> => ({
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
    liked: await isLiked(doc._id),
  });

  return {
    artUrl,
    track,
    tracks: (docs) => Promise.all(docs.map(track)),
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
      artUrl: await artUrl(doc.artHash),
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

/** A library folder as clients see it. */
export const presentLibrary = (
  doc: Doc<"libraries">,
  scanning: boolean,
): (typeof Library)["Encoded"] => ({
  id: doc._id,
  name: doc.name,
  path: doc.path,
  visibility: doc.visibility,
  trackCount: doc.trackCount,
  lastScanAt: doc.lastScanAt ?? null,
  scanning,
});

/** A playlist summary with up to four covers for its mosaic. */
export const presentPlaylist = async (
  ctx: ReadCtx,
  presenter: Presenter,
  doc: Doc<"playlists">,
): Promise<(typeof Playlist)["Encoded"]> => {
  const items = await ctx.db
    .query("playlistItems")
    .withIndex("by_playlist", (q) => q.eq("playlistId", doc._id))
    .take(24);

  const tracks = await Promise.all(items.map((item) => ctx.db.get(item.trackId)));

  const hashes = [
    ...new Set(tracks.flatMap((track) => (track?.artHash === undefined ? [] : [track.artHash]))),
  ].slice(0, 4);

  const urls = await Promise.all(hashes.map(presenter.artUrl));
  const artUrls = urls.filter((url): url is string => url !== null);

  return {
    id: doc._id,
    name: doc.name,
    description: doc.description ?? null,
    trackCount: doc.trackCount,
    durationMs: doc.durationMs,
    artUrls,
    updatedAt: doc.updatedAt,
  };
};
