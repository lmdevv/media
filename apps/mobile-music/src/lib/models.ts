/**
 * The music app's records, as the core's commands answer them (`packages/commands` `music.*` and
 * `core.*`), named as old music's `@music/commands/models` named them so the screens read the same.
 */
import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

type Music = PlatformSdk["music"];

type Core = PlatformSdk["core"];

/** What a platform command resolves with. */
export type Answer<Method> = Method extends (...args: never) => Promise<infer Result>
  ? Result
  : never;

/** One row of a paginated platform query. */
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

/** An album's facts, as `music.albums.get` answers: its card, length, genre, and format. */
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

/** Someone on this server, such as a playlist's owner. */
export type UserId = NonNullable<Playlist["owner"]>["id"];

/** Someone you may share with, as `core.accounts.directory.list` answers. */
export type DirectoryPerson = Row<Core["accounts"]["directory"]["list"]>;

export type QueueItemId = Row<Music["queue"]["list"]>["itemId"];

/** A played song, as `music.history.list` answers. */
export type HistoryEntry = Row<Music["history"]["list"]>;

/** Who is signed in, as `core.auth.sessions.current` answers. */
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

/** The name a person goes by: the display name they set, else their username. */
export const nameOf = (person: {
  readonly username: string;
  readonly displayName: string | null;
}) => person.displayName ?? person.username;

/** An album with its songs, as old music's `albums.get` answered: the core's facts and every page of its songs. */
export type AlbumDetail = AlbumFacts & { readonly tracks: ReadonlyArray<Track> };

/** An artist with their albums and top songs, as old music's `artists.get` answered. */
export interface ArtistDetail {
  readonly artist: ArtistCard;
  readonly albums: ReadonlyArray<AlbumCard>;
  readonly topTracks: ReadonlyArray<Track>;
}

/** A playlist with its entries, as old music's `playlists.get` answered. */
export interface PlaylistDetail {
  readonly playlist: Playlist;
  readonly items: ReadonlyArray<PlaylistEntry>;
}
