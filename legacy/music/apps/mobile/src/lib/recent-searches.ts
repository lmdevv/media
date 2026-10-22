/**
 * A16 · Recently searched: the results this person opened from Search, newest first, kept on this
 * device. Each is a snapshot of what its row shows, so the list draws without asking the server.
 * The keychain holds about 2 KB per value, so the oldest entries go first when it would overflow.
 */
import { AlbumId, ArtistId, TrackId } from "@music/commands/ids";
import type { AlbumCard, ArtistCard, Track } from "@music/commands/models";
import { Option, Schema } from "effect";

const ArtUrl = Schema.NullOr(Schema.String);

/** An opened song, album, or artist. */
export const RecentItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("track"),
    id: TrackId,
    title: Schema.String,
    artist: Schema.String,
    artistId: ArtistId,
    album: Schema.String,
    albumId: AlbumId,
    artUrl: ArtUrl,
    liked: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("album"),
    id: AlbumId,
    title: Schema.String,
    artist: Schema.String,
    year: Schema.NullOr(Schema.Int),
    artUrl: ArtUrl,
  }),
  Schema.Struct({
    kind: Schema.Literal("artist"),
    id: ArtistId,
    name: Schema.String,
    albumCount: Schema.Int,
    artUrl: ArtUrl,
  }),
]);

/** An opened song, album, or artist. */
export type RecentItem = typeof RecentItem.Type;

/** Recently searched, as the keychain stores it. */
const StoredRecents = Schema.fromJsonString(Schema.Array(RecentItem));

const decodeStored = Schema.decodeUnknownOption(StoredRecents);

/** The stored list as written to the keychain. */
export const encodeRecents = Schema.encodeSync(StoredRecents);

/** The stored list, or none when nothing is stored or it no longer parses. */
export const decodeRecents = (stored: string | null): ReadonlyArray<RecentItem> =>
  Option.getOrElse(decodeStored(stored), () => []);

/** How many entries A16 keeps. */
const MAX_RECENTS = 8;

/** Bytes one keychain value may hold before SecureStore refuses it. */
export const MAX_STORED_BYTES = 2000;

const utf8 = new TextEncoder();

/** A song as recently searched. */
export const recentTrack = (track: Track): RecentItem => ({
  kind: "track",
  id: track.id,
  title: track.title,
  artist: track.artist,
  artistId: track.artistId,
  album: track.album,
  albumId: track.albumId,
  artUrl: track.artUrl,
  liked: track.liked,
});

/** An album as recently searched. */
export const recentAlbum = (album: AlbumCard): RecentItem => ({
  kind: "album",
  id: album.id,
  title: album.title,
  artist: album.artist,
  year: album.year,
  artUrl: album.artUrl,
});

/** An artist as recently searched. */
export const recentArtist = (artist: ArtistCard): RecentItem => ({
  kind: "artist",
  id: artist.id,
  name: artist.name,
  albumCount: artist.albumCount,
  artUrl: artist.artUrl,
});

/** The key that tells two entries are the same result. */
export const recentKey = (item: RecentItem): string => `${item.kind}:${item.id}`;

/**
 * `recents` with `item` moved to the front, once, keeping the newest entries that fit both the
 * count and the keychain's size. Opening the same result again refreshes its snapshot.
 */
export const rememberRecent = (
  recents: ReadonlyArray<RecentItem>,
  item: RecentItem,
): ReadonlyArray<RecentItem> => {
  const key = recentKey(item);
  const next = [item, ...recents.filter((entry) => recentKey(entry) !== key)].slice(0, MAX_RECENTS);

  while (next.length > 1 && utf8.encode(encodeRecents(next)).length > MAX_STORED_BYTES) next.pop();

  return next;
};
