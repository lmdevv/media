import { TICKET_PARAM, artworkTicketId } from "@media/contracts/ticket";

import type { Handlers as AlbumHandlers } from "../../commands/music/albums";
import type { Handlers as ArtistHandlers } from "../../commands/music/artists";
import type { Handlers as PlaylistHandlers } from "../../commands/music/playlists";
import type { Handlers as TrackHandlers } from "../../commands/music/tracks";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { issueShareableTicket } from "../core/tickets";

type Result<H> = H extends (...args: never) => infer Answer ? Awaited<Answer> : never;

/** A song as the music commands answer it. */
export type Track = Result<TrackHandlers["list"]>["page"][number];

/** An album in a row or a list. */
export type AlbumCard = Result<AlbumHandlers["list"]>["page"][number];

/** An artist in a row or a list. */
export type ArtistCard = Result<ArtistHandlers["list"]>["page"][number];

/** A playlist's summary. */
export type Playlist = Result<PlaylistHandlers["get"]>;

/** Someone named on shared things. */
export type Contributor = NonNullable<Playlist["owner"]>;

/**
 * The path of a music artwork on the media server with its shareable `image` ticket (ADR 0011):
 * `/music/art/<hash>?ticket=<ticket>`. The ticket names `artworkTicketId(hash)`, the same string
 * for a week, so a query may issue it and image caches keep working.
 */
const artPath = async (hash: string): Promise<string> => {
  const { ticket } = await issueShareableTicket({
    kind: "artwork",
    id: await artworkTicketId(hash),
  });

  return `/music/art/${encodeURIComponent(hash)}?${TICKET_PARAM}=${ticket}`;
};

/** Presents catalog rows for one call, signing each artwork it names once. */
export interface MusicPresenter {
  readonly art: (hash: string | null) => Promise<string | null>;
  readonly track: (track: Doc<"tracks">, liked: boolean) => Promise<Track>;
  readonly album: (album: Doc<"albums">) => Promise<AlbumCard>;
  /** An artist with the artwork to show for them: their own, or their newest album's. */
  readonly artist: (artist: Doc<"artists">, artHash: string | null) => Promise<ArtistCard>;
}

/** A presenter for one call. */
export const musicPresenter = (): MusicPresenter => {
  const paths = new Map<string, Promise<string>>();

  const art = async (hash: string | null): Promise<string | null> => {
    if (hash === null) return null;

    const known = paths.get(hash);

    if (known !== undefined) return known;

    const path = artPath(hash);

    paths.set(hash, path);

    return path;
  };

  return {
    art,
    track: async (track, liked) => ({
      id: track._id,
      title: track.title,
      artist: track.artistName,
      artistId: track.artistId,
      album: track.albumTitle,
      albumId: track.albumId,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      durationMs: track.durationMs,
      codec: track.codec,
      lossless: track.lossless,
      bitrate: track.bitrate,
      sampleRate: track.sampleRate,
      bitDepth: track.bitDepth,
      artUrl: await art(track.artHash),
      liked,
    }),
    album: async (album) => ({
      id: album._id,
      title: album.title,
      artist: album.artistName,
      artistId: album.artistId,
      year: album.year,
      artUrl: await art(album.artHash),
      trackCount: album.trackCount,
    }),
    artist: async (artist, artHash) => ({
      id: artist._id,
      name: artist.name,
      albumCount: artist.albumCount,
      artUrl: await art(artHash),
    }),
  };
};

/** Albums one artist's artwork fallback reads at most: their newest. */
export const ARTIST_ART_ALBUMS = 4;

/**
 * The artwork to show for an artist: their own, or else the newest of their albums on disk with
 * artwork among their `ARTIST_ART_ALBUMS` newest, as old music showed. An artist's albums are in
 * the artist's own library, so whoever sees the artist sees them. Reads one index range when the
 * artist has no artwork of their own.
 */
export const artistArt = async (
  db: DatabaseReader,
  artist: Doc<"artists">,
): Promise<string | null> => {
  if (artist.artHash !== null) return artist.artHash;

  const albums = await db
    .query("albums")
    .withIndex("by_artist_year", (q) => q.eq("artistId", artist._id))
    .order("desc")
    .take(ARTIST_ART_ALBUMS);

  return albums.find((album) => album.artHash !== null && album.trackCount > 0)?.artHash ?? null;
};

/**
 * Which of `trackIds` the person likes: one index range and at most one row each, which
 * `LIKED_READS` charges.
 */
export const likedAmong = async (
  db: DatabaseReader,
  userId: Id<"users">,
  trackIds: ReadonlyArray<Id<"tracks">>,
): Promise<ReadonlySet<Id<"tracks">>> => {
  const found = await Promise.all(
    [...new Set(trackIds)].map(async (trackId) =>
      db
        .query("likes")
        .withIndex("by_user_track", (q) => q.eq("userId", userId).eq("trackId", trackId))
        .first(),
    ),
  );

  return new Set(found.flatMap((like) => (like === null ? [] : [like.trackId])));
};

/**
 * Names people for one call, reading each once: their display name, or their username. Null for
 * someone whose account is gone.
 */
export const contributors = (
  db: DatabaseReader,
): ((userId: Id<"users">) => Promise<Contributor | null>) => {
  const known = new Map<Id<"users">, Promise<Contributor | null>>();

  return async (userId) => {
    const cached = known.get(userId);

    if (cached !== undefined) return cached;

    const found = db
      .get(userId)
      .then((user) =>
        user?.kind === "person" ? { id: user._id, name: user.displayName ?? user.username } : null,
      );

    known.set(userId, found);

    return found;
  };
};
