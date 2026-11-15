/**
 * The music app's records, as the core's commands answer them (`packages/commands` `music.*` and
 * `core.*`).
 */
import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

type Music = PlatformSdk["music"];

type Core = PlatformSdk["core"];

export type Answer<Method> = Method extends (...args: never) => Promise<infer Result>
  ? Result
  : never;

export type Row<
  Method extends (...args: never) => Promise<{ readonly page: ReadonlyArray<unknown> }>,
> = Answer<Method>["page"][number];

/** A song you may see, with whether you like it. */
export type Track = Answer<Music["tracks"]["get"]>;

export type TrackId = Track["id"];

export type AlbumId = Track["albumId"];

export type ArtistId = Track["artistId"];

export type AlbumCard = Row<Music["albums"]["list"]>;

export type ArtistCard = Row<Music["artists"]["list"]>;

type AlbumFacts = Answer<Music["albums"]["get"]>;

export type Home = Answer<Music["library"]["home"]>;

export type SearchResults = Answer<Music["library"]["search"]>;

export type Playlist = Answer<Music["playlists"]["get"]>;

export type PlaylistId = Playlist["id"];

export type PlaylistAccess = Playlist["access"];

export type PlaylistVisibility = Playlist["visibility"];

export type PlaylistEntry = Row<Music["playlists"]["items"]>;

export type PlaylistItemId = PlaylistEntry["itemId"];

export type PlaylistSharing = Answer<Music["playlists"]["sharing"]>;

/** A role a playlist is shared with by name: it plays, or it also changes the songs. */
export type PlaylistRole = PlaylistSharing["people"][number]["role"];

export type UserId = NonNullable<Playlist["owner"]>["id"];

export type DirectoryPerson = Row<Core["accounts"]["directory"]["list"]>;

export type QueueItemId = Row<Music["queue"]["list"]>["itemId"];

export type HistoryEntry = Row<Music["history"]["list"]>;

export type Me = Answer<Core["auth"]["sessions"]["current"]>;

/**
 * IDs read from a route's path or a stored download. They are not checked here: the core checks
 * every ID it is sent, so a mistyped one fails the screen's query.
 */
export const asAlbumId = Brand.nominal<AlbumId>();

export const asArtistId = Brand.nominal<ArtistId>();

export const asPlaylistId = Brand.nominal<PlaylistId>();

export const asTrackId = Brand.nominal<TrackId>();

export const asUserId = Brand.nominal<UserId>();

export const asQueueItemId = Brand.nominal<QueueItemId>();

export const nameOf = (person: {
  readonly username: string;
  readonly displayName: string | null;
}) => person.displayName ?? person.username;

/** An album's facts and every page of its songs. */
export type AlbumDetail = AlbumFacts & { readonly tracks: ReadonlyArray<Track> };

export interface ArtistDetail {
  readonly artist: ArtistCard;
  readonly albums: ReadonlyArray<AlbumCard>;
  readonly topTracks: ReadonlyArray<Track>;
}

export interface PlaylistDetail {
  readonly playlist: Playlist;
  readonly items: ReadonlyArray<PlaylistEntry>;
}
