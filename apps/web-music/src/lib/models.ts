/**
 * The music client's records, as the core's music commands answer them (`packages/commands`
 * `music.*`), named as old music's `@music/commands/models` named them so the screens read the same.
 */
import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

type Music = PlatformSdk["music"];

type Answer<Method> = Method extends (...args: never) => Promise<infer Result> ? Result : never;

type Row<Method extends (...args: never) => Promise<{ readonly page: ReadonlyArray<unknown> }>> =
  Answer<Method>["page"][number];

export type { QueueTrack as QueueEntry } from "@media/player/react";

/** A song you may see, with whether you like it. */
export type Track = Answer<Music["tracks"]["get"]>;

export type TrackId = Track["id"];

export type AlbumId = Track["albumId"];

export type ArtistId = Track["artistId"];

export type AlbumCard = Row<Music["albums"]["list"]>;

export type ArtistCard = Row<Music["artists"]["list"]>;

export type SearchResults = Answer<Music["library"]["search"]>;

export type Playlist = Answer<Music["playlists"]["get"]>;

export type PlaylistId = Playlist["id"];

export type PlaylistAccess = Playlist["access"];

export type PlaylistVisibility = Playlist["visibility"];

export type PlaylistEntry = Row<Music["playlists"]["items"]>;

export type PlaylistItemId = PlaylistEntry["itemId"];

/** A role a playlist is shared with by name: it plays, or it also changes the songs. */
export type PlaylistRole = Answer<Music["playlists"]["sharing"]>["people"][number]["role"];

/** Someone on this server, such as a playlist's owner. */
export type UserId = NonNullable<Playlist["owner"]>["id"];

export type QueueItemId = Row<Music["queue"]["list"]>["itemId"];

/** Songs a playlist holds at most, as old music's `PLAYLIST_LIMIT`. */
export const PLAYLIST_LIMIT = 2000;

/**
 * IDs read from a route's path or search. They are not checked here: the core checks every ID it
 * is sent, so a mistyped one fails the screen's query.
 */
export const asAlbumId = Brand.nominal<AlbumId>();

export const asArtistId = Brand.nominal<ArtistId>();

export const asPlaylistId = Brand.nominal<PlaylistId>();

export const asTrackId = Brand.nominal<TrackId>();
